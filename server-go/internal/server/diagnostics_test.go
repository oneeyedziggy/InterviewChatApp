package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

type diagnosticsStub struct {
	snapshot ManagerDiagnostics
}

func (stub diagnosticsStub) DiagnosticsSnapshot() ManagerDiagnostics {
	return stub.snapshot
}

func TestDiagnosticsHealthAndMetrics(t *testing.T) {
	handler := NewDiagnosticsHandler(diagnosticsStub{snapshot: ManagerDiagnostics{
		Ready:             true,
		RegisteredTenants: 3,
		LoadedTenants:     2,
	}})

	readyRequest := httptest.NewRequest(http.MethodGet, "/health/ready", nil)
	readyResponse := httptest.NewRecorder()
	handler.ServeHTTP(readyResponse, readyRequest)
	if readyResponse.Code != http.StatusOK {
		t.Fatalf("expected ready status, got %d", readyResponse.Code)
	}

	metricsRequest := httptest.NewRequest(http.MethodGet, "/debug/metrics", nil)
	metricsResponse := httptest.NewRecorder()
	handler.ServeHTTP(metricsResponse, metricsRequest)
	if metricsResponse.Code != http.StatusOK {
		t.Fatalf("expected metrics status, got %d", metricsResponse.Code)
	}
	if metricsResponse.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("expected no-store metrics response")
	}
	var body diagnosticsResponse
	if err := json.Unmarshal(metricsResponse.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode metrics response: %v", err)
	}
	if body.Manager.RegisteredTenants != 3 || body.Manager.LoadedTenants != 2 {
		t.Fatalf("unexpected manager metrics: %+v", body.Manager)
	}
	if body.Runtime.Goroutines < 1 {
		t.Fatalf("expected runtime goroutine count, got %+v", body.Runtime)
	}
}

func TestDiagnosticsReadinessFailure(t *testing.T) {
	handler := NewDiagnosticsHandler(diagnosticsStub{})
	request := httptest.NewRequest(http.MethodGet, "/health/ready", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected not-ready status, got %d", response.Code)
	}
}
