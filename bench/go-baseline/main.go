package main

import (
	"io"
	"log"
	"net/http"
	"os"
)

func main() {
	upstream := os.Getenv("UPSTREAM_URL")
	client := &http.Client{}
	http.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, upstream+"/v1/chat/completions", r.Body)
		if err != nil { http.Error(w, err.Error(), 500); return }
		req.Header = r.Header.Clone()
		resp, err := client.Do(req)
		if err != nil { http.Error(w, err.Error(), 502); return }
		defer resp.Body.Close()
		for key, values := range resp.Header { for _, value := range values { w.Header().Add(key, value) } }
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
	})
	log.Fatal(http.ListenAndServe(":3010", nil))
}

