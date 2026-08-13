package main

import (
	"bytes"
	"testing"
)

func testMessage(seq, random, when uint64) []byte {
	head := protobufMessage(func(dst *bytes.Buffer) {
		putVarint(dst, 4, random)
		putVarint(dst, 6, when)
		putVarint(dst, 11, seq)
	})
	body := protobufMessage(func(dst *bytes.Buffer) {
		putBytes(dst, 1, protobufMessage(func(rich *bytes.Buffer) {
			putBytes(rich, 2, protobufMessage(func(elem *bytes.Buffer) {
				putBytes(elem, 1, []byte("payload"))
			}))
		}))
	})
	return protobufMessage(func(dst *bytes.Buffer) {
		putBytes(dst, 2, head)
		putBytes(dst, 3, body)
	})
}

func testPage(messages ...[]byte) []byte {
	return protobufMessage(func(dst *bytes.Buffer) {
		putBytes(dst, 7, protobufMessage(func(page *bytes.Buffer) {
			for _, message := range messages {
				putBytes(page, 1, message)
			}
		}))
	})
}

func TestLocateMessageBySeqAndRandom(t *testing.T) {
	response := testPage(
		testMessage(100, 200, 1000),
		testMessage(101, 201, 1001),
		testMessage(102, 202, 1002),
	)
	target := pullTarget{MsgSeq: 101, Random: 201, MatchRandom: true}
	found, messages := locateMessage(response, target)
	if len(messages) != 3 {
		t.Fatalf("got %d messages, want 3", len(messages))
	}
	if found.MsgSeq != 101 || found.MsgRandom != 201 || found.MsgTime != 1001 {
		t.Fatalf("unexpected match: %+v", found)
	}
}

func TestLocateMessageRejectsWrongRandom(t *testing.T) {
	response := testPage(testMessage(101, 999, 1001))
	found, _ := locateMessage(response, pullTarget{MsgSeq: 101, Random: 201, MatchRandom: true})
	if len(found.Raw) != 0 {
		t.Fatalf("matched wrong msgRandom: %+v", found)
	}
}

func TestPrivateCursorMovesToOlderPage(t *testing.T) {
	messages := []locatedMessage{{MsgSeq: 110, MsgTime: 1010}, {MsgSeq: 109, MsgTime: 1009}}
	next, ok := nextPullCursor(pullTarget{ChatType: 1, MsgSeq: 90}, messages, 1011)
	if !ok || next != 1008 {
		t.Fatalf("next cursor = %d, %v; want 1008, true", next, ok)
	}
}

func TestGroupCursorMovesTowardTarget(t *testing.T) {
	messages := []locatedMessage{{MsgSeq: 100}, {MsgSeq: 119}}
	next, ok := nextPullCursor(pullTarget{ChatType: 2, MsgSeq: 80}, messages, 119)
	if !ok || next != 99 {
		t.Fatalf("next cursor = %d, %v; want 99, true", next, ok)
	}
}
