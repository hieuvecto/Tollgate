package main

import (
	"bytes"
	"strings"
	"testing"
)

type flushingBuffer struct {
	bytes.Buffer
	flushes int
}

func (buffer *flushingBuffer) Flush() { buffer.flushes++ }

func TestCopyFlushingFlushesStreamingChunks(t *testing.T) {
	destination := &flushingBuffer{}
	if err := copyFlushing(destination, strings.NewReader("streamed response")); err != nil {
		t.Fatal(err)
	}
	if destination.String() != "streamed response" {
		t.Fatalf("unexpected body: %q", destination.String())
	}
	if destination.flushes == 0 {
		t.Fatal("expected at least one flush")
	}
}
