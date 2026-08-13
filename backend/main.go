package main

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
	_ "unsafe"

	"github.com/LagrangeDev/LagrangeGo/client"
	"github.com/LagrangeDev/LagrangeGo/client/auth"
	"github.com/LagrangeDev/LagrangeGo/client/sign"
	tea "github.com/fumiama/gofastTEA"
	_ "modernc.org/sqlite"
)

type config struct {
	Listen      string `json:"listen"`
	SessionFile string `json:"sessionFile"`
	QsignURL    string `json:"qsignUrl"`
	QsignKey    string `json:"qsignKey"`
}

type sessionFile struct {
	Uin         uint32 `json:"uin"`
	UID         string `json:"uid"`
	GUID        string `json:"guid"`
	AndroidID   string `json:"androidId"`
	Qimei36     string `json:"qimei36"`
	DeviceName  string `json:"deviceName"`
	VersionName string `json:"versionName"`
	VersionCode int    `json:"versionCode"`
	QUA         string `json:"qua"`
	D2          string `json:"d2"`
	D2Key       string `json:"d2Key"`
	TGT         string `json:"tgt"`
	TGTGT       string `json:"tgtgt"`
}

type pullRequest struct {
	Record struct {
		MsgSeq    any `json:"msgSeq"`
		MsgRandom any `json:"msgRandom"`
		MsgTime   any `json:"msgTime"`
		ChatType  any `json:"chatType"`
		PeerUin   any `json:"peerUin"`
		PeerUID   any `json:"peerUid"`
	} `json:"record"`
	Context struct {
		ChatType any `json:"chatType"`
		PeerUin  any `json:"peerUin"`
		PeerUID  any `json:"peerUid"`
	} `json:"context"`
}

const (
	pullPageSize = 20
	maxPullPages = 256
)

type pullTarget struct {
	ChatType    int64
	MsgSeq      uint64
	Random      uint64
	MatchRandom bool
	When        int64
	GroupUin    uint64
	PeerUID     string
}

type protoField struct {
	Number int
	Wire   int
	Varint uint64
	Bytes  []byte
}

type locatedMessage struct {
	Raw       []byte
	MsgSeq    uint64
	MsgRandom uint64
	MsgTime   uint64
}

type backend struct {
	cfg       config
	session   sessionFile
	client    *client.QQClient
	mu        sync.Mutex
	err       error
	started   time.Time
	connected bool
	synced    bool
	signer    *qsignProvider
}

// clientConnect opens LagrangeGo's transport without forcing its desktop
// StatusService.Register packet. Imported Android D2 tickets can authorize
// ordinary SSO requests directly, while that desktop-shaped registration is
// rejected by newer mobile sessions.
//
//go:linkname clientConnect github.com/LagrangeDev/LagrangeGo/client.(*QQClient).connect
func clientConnect(*client.QQClient) error

type logger struct{}

func (logger) Infof(string, ...any)    {}
func (logger) Warningf(string, ...any) {}
func (logger) Errorf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[mobile-sso] "+format+"\n", args...)
}
func (logger) Debugf(string, ...any)       {}
func (logger) Dump([]byte, string, ...any) {}

type qsignProvider struct {
	base      string
	key       string
	androidID string
	qimei36   string
	client    *http.Client
	mu        sync.Mutex
	pending   []qsignCallback
	suppress  bool
}

type qsignCallback struct {
	Command    string `json:"cmd"`
	Body       string `json:"body"`
	CallbackID int    `json:"callbackId"`
}

var errQsignCallbacks = errors.New("qsign callbacks pending")

type qsignEnvelope struct {
	Code int    `json:"code"`
	Msg  string `json:"msg"`
	Data struct {
		Token           string          `json:"token"`
		Extra           string          `json:"extra"`
		Sign            string          `json:"sign"`
		RequestCallback []qsignCallback `json:"requestCallback"`
	} `json:"data"`
}

func (p *qsignProvider) Sign(cmd string, seq uint32, data []byte, uin uint32, guid, qua string) (*sign.Response, error) {
	values := url.Values{
		"uin": {strconv.FormatUint(uint64(uin), 10)}, "qua": {qua}, "cmd": {cmd},
		"seq": {strconv.FormatUint(uint64(seq), 10)}, "buffer": {hex.EncodeToString(data)},
		"android_id": {p.androidID}, "guid": {strings.ToLower(guid)}, "qimei36": {p.qimei36},
	}
	req, err := http.NewRequest(http.MethodPost, strings.TrimRight(p.base, "/")+"/sign", strings.NewReader(values.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if p.key != "" {
		req.Header.Set("X-SECURITY-KEY", p.key)
	}
	res, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("qsign: %w", err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("qsign HTTP %d: %s", res.StatusCode, body)
	}
	var envelope qsignEnvelope
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, fmt.Errorf("qsign JSON: %w", err)
	}
	if envelope.Code != 0 {
		return nil, fmt.Errorf("qsign %d: %s", envelope.Code, envelope.Msg)
	}
	if len(envelope.Data.RequestCallback) > 0 {
		p.mu.Lock()
		if !p.suppress {
			p.pending = append(p.pending, envelope.Data.RequestCallback...)
			p.mu.Unlock()
			return nil, errQsignCallbacks
		}
		p.mu.Unlock()
	}
	decode := func(value string) ([]byte, error) {
		if value == "" {
			return nil, nil
		}
		return hex.DecodeString(value)
	}
	secSign, err := decode(envelope.Data.Sign)
	if err != nil {
		return nil, err
	}
	secToken, err := decode(envelope.Data.Token)
	if err != nil {
		return nil, err
	}
	secExtra, err := decode(envelope.Data.Extra)
	if err != nil {
		return nil, err
	}
	response := &sign.Response{Code: 0, Message: envelope.Msg}
	response.Value.SecSign = secSign
	response.Value.SecToken = secToken
	response.Value.SecExtra = secExtra
	return response, nil
}

func (p *qsignProvider) drainCallbacks() []qsignCallback {
	p.mu.Lock()
	defer p.mu.Unlock()
	result := append([]qsignCallback(nil), p.pending...)
	p.pending = nil
	return result
}

func (p *qsignProvider) setSuppress(value bool) {
	p.mu.Lock()
	p.suppress = value
	p.mu.Unlock()
}

func (p *qsignProvider) submit(uin uint32, callback qsignCallback, response []byte) error {
	values := url.Values{
		"uin":         {strconv.FormatUint(uint64(uin), 10)},
		"cmd":         {callback.Command},
		"callback_id": {strconv.Itoa(callback.CallbackID)},
		"buffer":      {hex.EncodeToString(response)},
	}
	req, err := http.NewRequest(http.MethodGet, strings.TrimRight(p.base, "/")+"/submit?"+values.Encode(), nil)
	if err != nil {
		return err
	}
	if p.key != "" {
		req.Header.Set("X-SECURITY-KEY", p.key)
	}
	res, err := p.client.Do(req)
	if err != nil {
		return fmt.Errorf("qsign submit: %w", err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("qsign submit HTTP %d: %s", res.StatusCode, body)
	}
	var envelope struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return fmt.Errorf("qsign submit JSON: %w", err)
	}
	if envelope.Code != 0 {
		return fmt.Errorf("qsign submit %d: %s", envelope.Code, envelope.Msg)
	}
	return nil
}
func (p *qsignProvider) AddRequestHeader(map[string]string) {}
func (p *qsignProvider) SetAppInfo(*auth.AppInfo)           {}
func (p *qsignProvider) Release()                           {}

func parseConfig() (config, error) {
	if len(os.Args) < 2 {
		return config{}, errors.New("missing config path")
	}
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		return config{}, err
	}
	var cfg config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return cfg, err
	}
	if cfg.Listen == "" {
		cfg.Listen = "127.0.0.1:18081"
	}
	return cfg, nil
}

type identityProbe struct {
	Identity struct {
		AndroidID   string `json:"androidId"`
		Qimei36     string `json:"qimei36"`
		VersionName string `json:"versionName"`
		VersionCode int    `json:"versionCode"`
		QUA         string `json:"qua"`
	} `json:"identity"`
}

type deviceExport struct {
	AndroidID          string `json:"androidId"`
	DeviceName         string `json:"deviceName"`
	DeviceManufacturer string `json:"deviceManufacturer"`
	DeviceModel        string `json:"deviceModel"`
	VersionName        string `json:"versionName"`
	VersionCode        any    `json:"versionCode"`
}

// buildSession converts the private files exported by the import script into
// the small session file consumed by this backend. The TEA key is an Android
// QQ database-format constant; no account credential is embedded here.
func buildSession(root, output, uinText, uid string) error {
	uin64, err := strconv.ParseUint(strings.TrimSpace(uinText), 10, 32)
	if err != nil || uin64 == 0 {
		return errors.New("invalid authenticated QQ number")
	}
	database := root + "/private/databases/tk_file_back"
	db, err := sql.Open("sqlite", database+"?mode=ro")
	if err != nil {
		return err
	}
	defer db.Close()
	var encrypted []byte
	if err := db.QueryRow("SELECT tk_file_back FROM tk_file_back WHERE ID=0").Scan(&encrypted); err != nil {
		return fmt.Errorf("read mobile ticket database: %w", err)
	}
	key, _ := hex.DecodeString("a56f891feabe50f58390b30c0093d740")
	plain := tea.NewTeaCipher(key).Decrypt(encrypted)
	var accounts map[string]struct {
		TicketMap map[string]struct {
			D2    []int `json:"_D2"`
			D2Key []int `json:"_D2Key"`
			TGT   []int `json:"_TGT"`
			TGTGT []int `json:"_TGTKey"`
		} `json:"_tk_map"`
	}
	if err := json.Unmarshal(plain, &accounts); err != nil {
		return fmt.Errorf("decrypt mobile ticket database: %w", err)
	}
	account, ok := accounts[strconv.FormatUint(uin64, 10)]
	if !ok {
		return errors.New("authenticated QQ account was not found in the mobile ticket database")
	}
	var ticket struct {
		D2, D2Key, TGT, TGTGT []int
	}
	for _, candidate := range account.TicketMap {
		if len(candidate.D2) > 0 && len(candidate.D2Key) == 16 {
			ticket.D2, ticket.D2Key, ticket.TGT, ticket.TGTGT = candidate.D2, candidate.D2Key, candidate.TGT, candidate.TGTGT
			break
		}
	}
	if len(ticket.D2) == 0 || len(ticket.D2Key) != 16 {
		return errors.New("mobile login ticket is incomplete")
	}
	toHex := func(values []int) string {
		result := make([]byte, len(values))
		for index, value := range values {
			result[index] = byte(value)
		}
		return hex.EncodeToString(result)
	}
	var probe identityProbe
	if data, readErr := os.ReadFile(root + "/private/files/ono-client-sign-probe.json"); readErr == nil {
		_ = json.Unmarshal(bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf}), &probe)
	}
	var device deviceExport
	if data, readErr := os.ReadFile(root + "/device.json"); readErr == nil {
		_ = json.Unmarshal(bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf}), &device)
	}
	versionName := probe.Identity.VersionName
	if versionName == "" {
		versionName = device.VersionName
	}
	versionCode := probe.Identity.VersionCode
	if versionCode == 0 {
		versionCode, _ = strconv.Atoi(dynamicString(device.VersionCode))
	}
	qua := probe.Identity.QUA
	if qua == "" && versionName != "" && versionCode != 0 {
		qua = fmt.Sprintf("V1_AND_SQ_%s_%d_YYB_D", versionName, versionCode)
	}
	androidID := probe.Identity.AndroidID
	if androidID == "" {
		androidID = device.AndroidID
	}
	deviceName := strings.TrimSpace(device.DeviceName)
	if deviceName == "" {
		deviceName = strings.TrimSpace(device.DeviceManufacturer + " " + device.DeviceModel)
	}
	guid, err := os.ReadFile(root + "/private/files/wlogin_device.dat")
	if err != nil {
		return fmt.Errorf("read mobile GUID: %w", err)
	}
	session := sessionFile{Uin: uint32(uin64), UID: uid, GUID: hex.EncodeToString(guid), AndroidID: androidID,
		Qimei36: probe.Identity.Qimei36, DeviceName: deviceName, VersionName: versionName,
		VersionCode: versionCode, QUA: qua, D2: toHex(ticket.D2), D2Key: toHex(ticket.D2Key),
		TGT: toHex(ticket.TGT), TGTGT: toHex(ticket.TGTGT)}
	encoded, _ := json.MarshalIndent(session, "", "  ")
	if err := os.WriteFile(output, encoded, 0600); err != nil {
		return err
	}
	fmt.Printf("SESSION_READY uin=%d version=%s\n", session.Uin, session.VersionName)
	return nil
}

func hexBytes(value string) ([]byte, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	return hex.DecodeString(value)
}

func newBackend(cfg config) (*backend, error) {
	data, err := os.ReadFile(cfg.SessionFile)
	if err != nil {
		return nil, err
	}
	var sf sessionFile
	if err := json.Unmarshal(data, &sf); err != nil {
		return nil, err
	}
	d2, err := hexBytes(sf.D2)
	if err != nil {
		return nil, fmt.Errorf("D2: %w", err)
	}
	d2Key, err := hexBytes(sf.D2Key)
	if err != nil {
		return nil, fmt.Errorf("D2Key: %w", err)
	}
	tgt, err := hexBytes(sf.TGT)
	if err != nil {
		return nil, fmt.Errorf("TGT: %w", err)
	}
	tgtgt, err := hexBytes(sf.TGTGT)
	if err != nil {
		return nil, fmt.Errorf("TGTGT: %w", err)
	}
	if sf.Uin == 0 || len(d2) == 0 || len(d2Key) != 16 {
		return nil, errors.New("mobile login ticket is incomplete")
	}
	version := &auth.AppInfo{
		OS: "Android", Kernel: "Linux", VendorOS: "android", CurrentVersion: sf.VersionName,
		BuildVersion: sf.VersionCode, MiscBitmap: 150470524, PTVersion: "2.0.0", PTOSVersion: 23,
		PackageName: "com.tencent.mobileqq", WTLoginSDK: "nt.wtlogin.0.0.1", PackageSign: sf.QUA,
		AppID: 1600000226, SubAppID: 537380883, AppClientVersion: sf.VersionCode,
		MainSigmap: 16724722, SubSigmap: 66560, NTLoginType: 1,
	}
	qq, signer := makeClient(cfg, sf, version, d2, d2Key, tgt, tgtgt)
	return &backend{cfg: cfg, session: sf, client: qq, signer: signer, started: time.Now()}, nil
}

func makeClient(cfg config, sf sessionFile, version *auth.AppInfo, d2, d2Key, tgt, tgtgt []byte) (*client.QQClient, *qsignProvider) {
	qq := client.NewClientEmpty()
	qq.SetLogger(logger{})
	qq.UseVersion(version)
	qq.UseDevice(&auth.DeviceInfo{GUID: strings.ToUpper(sf.GUID), DeviceName: sf.DeviceName, SystemKernel: "Android", KernelVersion: "16"})
	signer := &qsignProvider{base: cfg.QsignURL, key: cfg.QsignKey, androidID: sf.AndroidID, qimei36: sf.Qimei36, client: &http.Client{Timeout: 12 * time.Second}}
	qq.UseSignProvider(signer)
	qq.UseSig(auth.SigInfo{Uin: sf.Uin, UID: sf.UID, D2: d2, D2Key: d2Key, Tgt: tgt, Tgtgt: tgtgt})
	return qq, signer
}

func (b *backend) resetClient() error {
	d2, err := hexBytes(b.session.D2)
	if err != nil {
		return err
	}
	d2Key, err := hexBytes(b.session.D2Key)
	if err != nil {
		return err
	}
	tgt, err := hexBytes(b.session.TGT)
	if err != nil {
		return err
	}
	tgtgt, err := hexBytes(b.session.TGTGT)
	if err != nil {
		return err
	}
	version := &auth.AppInfo{
		OS: "Android", Kernel: "Linux", VendorOS: "android", CurrentVersion: b.session.VersionName,
		BuildVersion: b.session.VersionCode, MiscBitmap: 150470524, PTVersion: "2.0.0", PTOSVersion: 23,
		PackageName: "com.tencent.mobileqq", WTLoginSDK: "nt.wtlogin.0.0.1", PackageSign: b.session.QUA,
		AppID: 1600000226, SubAppID: 537380883, AppClientVersion: b.session.VersionCode,
		MainSigmap: 16724722, SubSigmap: 66560, NTLoginType: 1,
	}
	b.client, b.signer = makeClient(b.cfg, b.session, version, d2, d2Key, tgt, tgtgt)
	b.connected = false
	b.synced = false
	return nil
}

func dynamicString(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(x)
	case float64:
		return strconv.FormatInt(int64(x), 10)
	case json.Number:
		return x.String()
	default:
		return strings.TrimSpace(fmt.Sprint(x))
	}
}
func dynamicInt(v any) int64 { n, _ := strconv.ParseInt(dynamicString(v), 10, 64); return n }

func putVarint(dst *bytes.Buffer, field int, value uint64) {
	var scratch [20]byte
	n := binary.PutUvarint(scratch[:], uint64(field<<3))
	dst.Write(scratch[:n])
	n = binary.PutUvarint(scratch[:], value)
	dst.Write(scratch[:n])
}
func putBytes(dst *bytes.Buffer, field int, value []byte) {
	var scratch [20]byte
	n := binary.PutUvarint(scratch[:], uint64(field<<3|2))
	dst.Write(scratch[:n])
	n = binary.PutUvarint(scratch[:], uint64(len(value)))
	dst.Write(scratch[:n])
	dst.Write(value)
}

func protobufMessage(fields func(*bytes.Buffer)) []byte {
	var dst bytes.Buffer
	fields(&dst)
	return dst.Bytes()
}

func makeMobileRegister(session sessionFile) []byte {
	messageTime := protobufMessage(func(dst *bytes.Buffer) {
		putBytes(dst, 1, protobufMessage(func(v *bytes.Buffer) { putVarint(v, 1, 0) }))
		putVarint(dst, 2, 0)
		putBytes(dst, 3, protobufMessage(func(v *bytes.Buffer) { putVarint(v, 1, 0) }))
	})
	metadata := protobufMessage(func(dst *bytes.Buffer) {
		for _, pair := range [][2]uint64{{46, 0}, {283, 0}} {
			putBytes(dst, 1, protobufMessage(func(v *bytes.Buffer) {
				putVarint(v, 1, pair[0])
				putVarint(v, 2, pair[1])
			}))
		}
	})
	phoneInfo := protobufMessage(func(dst *bytes.Buffer) {
		putBytes(dst, 1, []byte(session.DeviceName))
		putBytes(dst, 2, []byte(session.DeviceName))
		putBytes(dst, 3, []byte("16"))
		putBytes(dst, 4, []byte("Xiaomi"))
		putBytes(dst, 5, []byte("Linux"))
	})
	deviceInfo := protobufMessage(func(dst *bytes.Buffer) {
		putBytes(dst, 1, []byte(strings.ToLower(session.GUID)))
		putVarint(dst, 2, 0)
		putBytes(dst, 3, []byte(strconv.Itoa(session.VersionCode)))
		putVarint(dst, 4, 1)
		putVarint(dst, 5, 2052)
		putBytes(dst, 6, phoneInfo)
		putVarint(dst, 7, 0)
		putVarint(dst, 8, 5)
		putVarint(dst, 9, 0)
		putBytes(dst, 10, protobufMessage(func(v *bytes.Buffer) { putVarint(v, 1, 1); putVarint(v, 2, 1) }))
		putVarint(dst, 11, 0)
	})
	return protobufMessage(func(dst *bytes.Buffer) {
		putVarint(dst, 1, 735)
		putVarint(dst, 2, uint64(time.Now().UnixNano()&0x7fffffff))
		putVarint(dst, 4, 2)
		putVarint(dst, 5, 0)
		putBytes(dst, 6, messageTime)
		putBytes(dst, 8, metadata)
		putBytes(dst, 9, deviceInfo)
		putBytes(dst, 10, protobufMessage(func(v *bytes.Buffer) { putVarint(v, 1, 0); putVarint(v, 2, 1) }))
		putBytes(dst, 11, protobufMessage(func(v *bytes.Buffer) { putVarint(v, 1, 0); putVarint(v, 2, 1); putVarint(v, 3, 0) }))
	})
}

// makeInitialMessageSync mirrors the lightweight MessageSvc.PbGetMsg request
// sent by Android QQ immediately after SsoInfoSync.  Merely registering the
// imported D2 makes the SSO connection usable, but the server does not attach
// the mobile message-storage session until this first synchronization request.
func makeInitialMessageSync(now int64) []byte {
	cookie := protobufMessage(func(dst *bytes.Buffer) {
		putVarint(dst, 2, uint64(now))
		putVarint(dst, 3, 758330138)
		putVarint(dst, 4, 2480149246)
		putVarint(dst, 5, 1167238020)
		putVarint(dst, 11, 3913056418)
		putVarint(dst, 12, 0x1D)
	})
	return protobufMessage(func(dst *bytes.Buffer) {
		putVarint(dst, 1, 0) // START
		putBytes(dst, 2, cookie)
		putVarint(dst, 4, 20)
		putVarint(dst, 5, 3)
		putVarint(dst, 6, 1)
		putVarint(dst, 7, 1)
		putVarint(dst, 9, 1)
		putBytes(dst, 10, nil)
		putBytes(dst, 11, nil)
		putBytes(dst, 12, nil)
	})
}

func pullTargetFromRequest(req pullRequest) (pullTarget, error) {
	chatType := dynamicInt(req.Record.ChatType)
	if chatType == 0 {
		chatType = dynamicInt(req.Context.ChatType)
	}
	seqText := dynamicString(req.Record.MsgSeq)
	seq, err := strconv.ParseUint(seqText, 10, 64)
	if err != nil || seq == 0 {
		return pullTarget{}, errors.New("missing msgSeq")
	}
	randomText := dynamicString(req.Record.MsgRandom)
	random, _ := strconv.ParseUint(randomText, 10, 64)
	target := pullTarget{ChatType: chatType, MsgSeq: seq, Random: random, MatchRandom: random > 0, When: dynamicInt(req.Record.MsgTime)}
	if chatType == 2 {
		group := dynamicString(req.Context.PeerUin)
		if group == "" {
			group = dynamicString(req.Record.PeerUin)
		}
		groupUin, _ := strconv.ParseUint(group, 10, 64)
		if groupUin == 0 {
			return pullTarget{}, errors.New("missing group UIN")
		}
		target.GroupUin = groupUin
		return target, nil
	}
	peer := dynamicString(req.Record.PeerUID)
	if peer == "" {
		peer = dynamicString(req.Context.PeerUID)
	}
	if peer == "" {
		return pullTarget{}, errors.New("missing peer UID")
	}
	if target.When <= 0 {
		target.When = time.Now().Unix()
	}
	target.PeerUID = peer
	return target, nil
}

func makePullPage(target pullTarget, cursor uint64) (string, string, []byte) {
	if target.ChatType == 2 {
		if cursor == 0 {
			cursor = target.MsgSeq
		}
		start := cursor
		if start >= pullPageSize-1 {
			start -= pullPageSize - 1
		} else {
			start = 1
		}
		var request bytes.Buffer
		putVarint(&request, 1, target.GroupUin)
		putVarint(&request, 2, start)
		putVarint(&request, 3, cursor)
		putVarint(&request, 6, 0)
		return "MessageSvc.PbGetGroupMsg", strconv.FormatUint(target.GroupUin, 10), request.Bytes()
	}
	var request bytes.Buffer
	when := target.When
	if cursor > 0 {
		when = int64(cursor)
	}
	putBytes(&request, 1, []byte(target.PeerUID))
	putVarint(&request, 2, uint64(when+1))
	putVarint(&request, 3, 0)
	putVarint(&request, 4, pullPageSize)
	putVarint(&request, 5, 1)
	return "trpc.msg.register_proxy.RegisterProxy.SsoGetRoamMsg", target.PeerUID, request.Bytes()
}

func parseProto(data []byte) ([]protoField, error) {
	fields := make([]protoField, 0, 8)
	for offset := 0; offset < len(data); {
		key, n := binary.Uvarint(data[offset:])
		if n <= 0 {
			return nil, errors.New("invalid protobuf key")
		}
		offset += n
		number, wire := int(key>>3), int(key&7)
		if number <= 0 {
			return nil, errors.New("invalid protobuf field number")
		}
		field := protoField{Number: number, Wire: wire}
		switch wire {
		case 0:
			value, used := binary.Uvarint(data[offset:])
			if used <= 0 {
				return nil, errors.New("invalid protobuf varint")
			}
			field.Varint = value
			offset += used
		case 1:
			if len(data)-offset < 8 {
				return nil, errors.New("truncated protobuf fixed64")
			}
			field.Bytes = data[offset : offset+8]
			offset += 8
		case 2:
			length, used := binary.Uvarint(data[offset:])
			if used <= 0 || length > uint64(len(data)-offset-used) {
				return nil, errors.New("invalid protobuf bytes length")
			}
			offset += used
			field.Bytes = data[offset : offset+int(length)]
			offset += int(length)
		case 5:
			if len(data)-offset < 4 {
				return nil, errors.New("truncated protobuf fixed32")
			}
			field.Bytes = data[offset : offset+4]
			offset += 4
		default:
			return nil, fmt.Errorf("unsupported protobuf wire type %d", wire)
		}
		fields = append(fields, field)
	}
	return fields, nil
}

func fieldVarint(fields []protoField, number int) uint64 {
	for _, field := range fields {
		if field.Number == number && field.Wire == 0 {
			return field.Varint
		}
	}
	return 0
}

func fieldBytes(fields []protoField, number int) []byte {
	for _, field := range fields {
		if field.Number == number && field.Wire == 2 {
			return field.Bytes
		}
	}
	return nil
}

func messageIdentity(message []byte) (locatedMessage, bool) {
	fields, err := parseProto(message)
	if err != nil {
		return locatedMessage{}, false
	}
	head := fieldBytes(fields, 2)
	if len(head) == 0 {
		return locatedMessage{}, false
	}
	headFields, err := parseProto(head)
	if err != nil {
		return locatedMessage{}, false
	}
	seq := fieldVarint(headFields, 11)
	if seq == 0 {
		return locatedMessage{}, false
	}
	return locatedMessage{
		Raw:       append([]byte(nil), message...),
		MsgSeq:    seq,
		MsgRandom: fieldVarint(headFields, 4),
		MsgTime:   fieldVarint(headFields, 6),
	}, true
}

func collectMessageCandidates(data []byte, depth int, out *[]locatedMessage) {
	if depth > 8 || len(data) == 0 {
		return
	}
	if message, ok := messageIdentity(data); ok {
		*out = append(*out, message)
		return
	}
	fields, err := parseProto(data)
	if err != nil {
		return
	}
	for _, field := range fields {
		if field.Wire == 2 {
			collectMessageCandidates(field.Bytes, depth+1, out)
		}
	}
}

func locateMessage(data []byte, target pullTarget) (locatedMessage, []locatedMessage) {
	messages := make([]locatedMessage, 0, pullPageSize)
	collectMessageCandidates(data, 0, &messages)
	seen := make(map[string]bool, len(messages))
	unique := messages[:0]
	for _, message := range messages {
		key := fmt.Sprintf("%d:%d:%d", message.MsgSeq, message.MsgRandom, message.MsgTime)
		if !seen[key] {
			seen[key] = true
			unique = append(unique, message)
		}
	}
	for _, message := range unique {
		if message.MsgSeq == target.MsgSeq && (!target.MatchRandom || message.MsgRandom == target.Random) {
			return message, unique
		}
	}
	return locatedMessage{}, unique
}

func nextPullCursor(target pullTarget, messages []locatedMessage, current uint64) (uint64, bool) {
	if len(messages) == 0 {
		return 0, false
	}
	if target.ChatType == 2 {
		minSeq, maxSeq := messages[0].MsgSeq, messages[0].MsgSeq
		for _, message := range messages[1:] {
			if message.MsgSeq < minSeq {
				minSeq = message.MsgSeq
			}
			if message.MsgSeq > maxSeq {
				maxSeq = message.MsgSeq
			}
		}
		if target.MsgSeq < minSeq && minSeq > 1 {
			return minSeq - 1, minSeq-1 != current
		}
		if target.MsgSeq > maxSeq {
			return maxSeq + pullPageSize, maxSeq+pullPageSize != current
		}
		return 0, false
	}
	oldest := uint64(0)
	for _, message := range messages {
		if message.MsgTime > 0 && (oldest == 0 || message.MsgTime < oldest) {
			oldest = message.MsgTime
		}
	}
	if oldest <= 1 || oldest == current {
		return 0, false
	}
	return oldest - 1, true
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func (b *backend) status(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, 200, map[string]any{"ok": b.err == nil, "online": b.client.Online.Load(), "uin": b.session.Uin, "uid": b.session.UID, "error": errorString(b.err), "uptimeMs": time.Since(b.started).Milliseconds()})
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func (b *backend) processQsignCallbacks(callbacks []qsignCallback) error {
	if len(callbacks) == 0 {
		return nil
	}
	b.signer.setSuppress(true)
	defer b.signer.setSuppress(false)
	for _, callback := range callbacks {
		body, err := hex.DecodeString(strings.TrimSpace(callback.Body))
		if err != nil {
			return fmt.Errorf("qsign callback %s body: %w", callback.Command, err)
		}
		response, err := b.client.SendSsoPacket(callback.Command, body)
		if err != nil {
			return fmt.Errorf("qsign callback %s: %w", callback.Command, err)
		}
		if err := b.signer.submit(b.session.Uin, callback, response); err != nil {
			return err
		}
	}
	return nil
}

func (b *backend) ensureRegistered() error {
	if b.client.Online.Load() {
		return nil
	}
	if !b.connected {
		b.client.Uin = b.session.Uin
		if err := clientConnect(b.client); err != nil {
			return err
		}
		b.connected = true
	}
	for attempt := 0; attempt < 4; attempt++ {
		response, err := b.client.SendSsoPacket(
			"trpc.msg.register_proxy.RegisterProxy.SsoInfoSync",
			makeMobileRegister(b.session),
		)
		callbacks := b.signer.drainCallbacks()
		if len(callbacks) > 0 {
			if callbackErr := b.processQsignCallbacks(callbacks); callbackErr != nil {
				return callbackErr
			}
			continue
		}
		if err == nil {
			_ = response // A successful SSO reply is sufficient; newer mobile builds omit the legacy text.
			b.client.Online.Store(true)
			// Android performs this before history/roam queries. We deliberately do
			// not decode or acknowledge returned messages here: it is only used to
			// initialize the server-side mobile message-storage context.
			if _, syncErr := b.client.SendSsoPacket("MessageSvc.PbGetMsg", makeInitialMessageSync(time.Now().Unix())); syncErr != nil {
				b.client.Online.Store(false)
				return fmt.Errorf("initial mobile message sync: %w", syncErr)
			}
			b.synced = true
			return nil
		}
		if !errors.Is(err, errQsignCallbacks) {
			return err
		}
	}
	return errors.New("qsign callback handshake did not converge")
}

func (b *backend) pull(w http.ResponseWriter, r *http.Request) {
	var req pullRequest
	decoder := json.NewDecoder(io.LimitReader(r.Body, 4<<20))
	decoder.UseNumber()
	if err := decoder.Decode(&req); err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "message": err.Error()})
		return
	}
	targetSpec, err := pullTargetFromRequest(req)
	if err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "message": err.Error()})
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if err = b.ensureRegistered(); err != nil {
		// A mobile SSO connection can be closed by the server while this helper is
		// idle. Rebuild the client once so callers do not have to restart QQ or the
		// bridge manually.
		if resetErr := b.resetClient(); resetErr == nil {
			err = b.ensureRegistered()
		}
		if err != nil {
			b.err = err
			writeJSON(w, 503, map[string]any{"ok": false, "message": "mobile session registration failed: " + err.Error()})
			return
		}
	}
	cursor := uint64(0)
	// C2C roam endpoints may return an empty page when queried at an exact old
	// message timestamp. Start from the current tail and walk backwards; this
	// also makes stale/inaccurate desktop msgTime values harmless.
	if targetSpec.ChatType != 2 {
		cursor = uint64(time.Now().Unix())
	}
	seenCursors := map[uint64]bool{}
	for page := 1; page <= maxPullPages; page++ {
		cmd, target, body := makePullPage(targetSpec, cursor)
		response, sendErr := b.client.SendSsoPacket(cmd, body)
		if sendErr != nil {
			// The socket may disappear after registration while Online is still true.
			// Recreate it and retry the current page exactly once.
			if resetErr := b.resetClient(); resetErr == nil {
				if registerErr := b.ensureRegistered(); registerErr == nil {
					response, sendErr = b.client.SendSsoPacket(cmd, body)
				}
			}
			if sendErr != nil {
				b.err = sendErr
				writeJSON(w, 502, map[string]any{"ok": false, "message": sendErr.Error(), "command": cmd, "target": target, "page": page})
				return
			}
		}
		found, messages := locateMessage(response, targetSpec)
		if len(found.Raw) > 0 {
			b.err = nil
			writeJSON(w, 200, map[string]any{
				"ok": true, "command": cmd, "target": target,
				"method": "mobile/LagrangeGo (auto-page)", "page": page,
				"matchedMsgSeq": found.MsgSeq, "matchedMsgRandom": found.MsgRandom,
				"rawBase64": base64.StdEncoding.EncodeToString(found.Raw),
				"rawHex":    strings.ToUpper(hex.EncodeToString(found.Raw)), "rawLength": len(found.Raw),
			})
			return
		}
		next, ok := nextPullCursor(targetSpec, messages, cursor)
		if !ok || seenCursors[next] {
			writeJSON(w, 404, map[string]any{
				"ok": false, "message": "mobile history exhausted before target message was found",
				"command": cmd, "target": target, "pagesScanned": page,
				"targetMsgSeq": targetSpec.MsgSeq, "targetMsgRandom": targetSpec.Random,
			})
			return
		}
		seenCursors[next] = true
		cursor = next
	}
	writeJSON(w, 404, map[string]any{
		"ok": false, "message": "target message was not found within pagination limit",
		"pagesScanned": maxPullPages, "targetMsgSeq": targetSpec.MsgSeq, "targetMsgRandom": targetSpec.Random,
	})
}

func main() {
	if len(os.Args) >= 2 && os.Args[1] == "build-session" {
		if len(os.Args) != 6 {
			panic("usage: build-session <extracted-root> <output> <uin> <uid>")
		}
		if err := buildSession(os.Args[2], os.Args[3], os.Args[4], os.Args[5]); err != nil {
			panic(err)
		}
		return
	}
	cfg, err := parseConfig()
	if err != nil {
		panic(err)
	}
	b, err := newBackend(cfg)
	if err != nil {
		panic(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/status", b.status)
	mux.HandleFunc("/pull", b.pull)
	fmt.Fprintln(os.Stdout, "LISTENING", cfg.Listen)
	if err := http.ListenAndServe(cfg.Listen, mux); err != nil {
		panic(err)
	}
}

var _ = tea.NewTeaCipher
