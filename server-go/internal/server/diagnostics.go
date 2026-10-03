package server

import (
	"encoding/json"
	"net/http"
	"net/http/pprof"
	"runtime"

	wsrt "chat-server-go/websocket"
)

type ManagerDiagnostics struct {
	Ready             bool             `json:"ready"`
	RegisteredTenants int              `json:"registeredTenants"`
	LoadedTenants     int              `json:"loadedTenants"`
	HTTP              HTTPStats        `json:"http"`
	Persistence       PersistenceStats `json:"persistence"`
	WebSocket         wsrt.Stats       `json:"websocket"`
}

type DiagnosticsSource interface {
	DiagnosticsSnapshot() ManagerDiagnostics
}

type runtimeDiagnostics struct {
	Goroutines      int    `json:"goroutines"`
	HeapAllocBytes  uint64 `json:"heapAllocBytes"`
	HeapInUseBytes  uint64 `json:"heapInUseBytes"`
	HeapObjects     uint64 `json:"heapObjects"`
	StackInUseBytes uint64 `json:"stackInUseBytes"`
	GCCount         uint32 `json:"gcCount"`
}

type diagnosticsResponse struct {
	Manager ManagerDiagnostics `json:"manager"`
	Runtime runtimeDiagnostics `json:"runtime"`
}

func NewDiagnosticsHandler(source DiagnosticsSource) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health/live", func(w http.ResponseWriter, _ *http.Request) {
		writeDiagnosticsJSON(w, http.StatusOK, map[string]string{"status": "live"})
	})
	mux.HandleFunc("/health/ready", func(w http.ResponseWriter, _ *http.Request) {
		snapshot := source.DiagnosticsSnapshot()
		if !snapshot.Ready {
			writeDiagnosticsJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not_ready"})
			return
		}
		writeDiagnosticsJSON(w, http.StatusOK, map[string]string{"status": "ready"})
	})
	mux.HandleFunc("/debug/metrics", func(w http.ResponseWriter, _ *http.Request) {
		var memory runtime.MemStats
		runtime.ReadMemStats(&memory)
		writeDiagnosticsJSON(w, http.StatusOK, diagnosticsResponse{
			Manager: source.DiagnosticsSnapshot(),
			Runtime: runtimeDiagnostics{
				Goroutines:      runtime.NumGoroutine(),
				HeapAllocBytes:  memory.HeapAlloc,
				HeapInUseBytes:  memory.HeapInuse,
				HeapObjects:     memory.HeapObjects,
				StackInUseBytes: memory.StackInuse,
				GCCount:         memory.NumGC,
			},
		})
	})
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	return mux
}

func writeDiagnosticsJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
