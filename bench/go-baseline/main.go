package main

import (
	"io"
	"log"
	"net/http"
	"os"
)

type flusher interface {
	Flush()
}

func copyFlushing(destination io.Writer, source io.Reader) error {
	buffer := make([]byte, 32*1024)
	for {
		read, readErr := source.Read(buffer)
		if read > 0 {
			written, writeErr := destination.Write(buffer[:read])
			if writeErr != nil {
				return writeErr
			}
			if written != read {
				return io.ErrShortWrite
			}
			if stream, ok := destination.(flusher); ok {
				stream.Flush()
			}
		}
		if readErr == io.EOF {
			return nil
		}
		if readErr != nil {
			return readErr
		}
	}
}

func main() {
	upstream := os.Getenv("UPSTREAM_URL")
	client := &http.Client{}
	http.HandleFunc("/v1/chat/completions", func(writer http.ResponseWriter, request *http.Request) {
		upstreamRequest, err := http.NewRequestWithContext(
			request.Context(),
			http.MethodPost,
			upstream+"/v1/chat/completions",
			request.Body,
		)
		if err != nil {
			http.Error(writer, err.Error(), http.StatusInternalServerError)
			return
		}
		upstreamRequest.Header = request.Header.Clone()
		response, err := client.Do(upstreamRequest)
		if err != nil {
			http.Error(writer, err.Error(), http.StatusBadGateway)
			return
		}
		defer response.Body.Close()
		for key, values := range response.Header {
			for _, value := range values {
				writer.Header().Add(key, value)
			}
		}
		writer.WriteHeader(response.StatusCode)
		if err := copyFlushing(writer, response.Body); err != nil {
			log.Printf("stream copy failed: %v", err)
		}
	})
	log.Fatal(http.ListenAndServe(":3010", nil))
}
