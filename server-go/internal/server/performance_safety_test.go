package server

import (
	"os"
	"path/filepath"
	"testing"
)

func TestValidatePerformanceEnvironmentDisabled(t *testing.T) {
	t.Setenv("PERFORMANCE_TEST_MODE", "")
	if err := ValidatePerformanceEnvironment(""); err != nil {
		t.Fatalf("disabled performance mode should not require guardrails: %v", err)
	}
}

func TestValidatePerformanceEnvironmentRequiresExplicitDataDirectory(t *testing.T) {
	t.Setenv("PERFORMANCE_TEST_MODE", "1")
	t.Setenv("PERFORMANCE_RUN_ID", "smoke-001")
	t.Setenv("SERVER_DATA_DIR", "")
	if err := ValidatePerformanceEnvironment(t.TempDir()); err == nil {
		t.Fatal("expected missing SERVER_DATA_DIR to fail")
	}
}

func TestValidatePerformanceEnvironmentRequiresMatchingMarker(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("PERFORMANCE_TEST_MODE", "1")
	t.Setenv("PERFORMANCE_RUN_ID", "smoke-001")
	t.Setenv("SERVER_DATA_DIR", dataDir)

	if err := os.WriteFile(filepath.Join(dataDir, PerformanceDataMarker), []byte("another-run\n"), 0o600); err != nil {
		t.Fatalf("write marker: %v", err)
	}
	if err := ValidatePerformanceEnvironment(dataDir); err == nil {
		t.Fatal("expected mismatched marker to fail")
	}

	if err := os.WriteFile(filepath.Join(dataDir, PerformanceDataMarker), []byte("smoke-001\n"), 0o600); err != nil {
		t.Fatalf("write matching marker: %v", err)
	}
	if err := ValidatePerformanceEnvironment(dataDir); err != nil {
		t.Fatalf("expected matching isolated directory to pass: %v", err)
	}
}

func TestValidatePerformanceEnvironmentRejectsInvalidRunID(t *testing.T) {
	t.Setenv("PERFORMANCE_TEST_MODE", "1")
	t.Setenv("PERFORMANCE_RUN_ID", "../../production")
	t.Setenv("SERVER_DATA_DIR", t.TempDir())
	if err := ValidatePerformanceEnvironment(t.TempDir()); err == nil {
		t.Fatal("expected unsafe run ID to fail")
	}
}

func TestValidatePerformanceTargetAllowsLoopback(t *testing.T) {
	for _, target := range []string{"http://127.0.0.1:3001", "ws://localhost:3001/ws/", "http://[::1]:3001"} {
		if err := ValidatePerformanceTarget(target); err != nil {
			t.Fatalf("expected loopback target %q to pass: %v", target, err)
		}
	}
}

func TestValidatePerformanceTargetRequiresRemoteAllowlist(t *testing.T) {
	t.Setenv("PERF_ALLOW_REMOTE", "")
	t.Setenv("PERF_ALLOWED_HOSTS", "")
	if err := ValidatePerformanceTarget("https://staging.example.com"); err == nil {
		t.Fatal("expected remote target without opt-in to fail")
	}

	t.Setenv("PERF_ALLOW_REMOTE", "1")
	t.Setenv("PERF_ALLOWED_HOSTS", "other.example.com,staging.example.com")
	if err := ValidatePerformanceTarget("https://staging.example.com/chat"); err != nil {
		t.Fatalf("expected allowlisted target to pass: %v", err)
	}
	if err := ValidatePerformanceTarget("https://production.example.com"); err == nil {
		t.Fatal("expected non-allowlisted target to fail")
	}
}

func TestValidatePerformanceTargetRejectsCredentials(t *testing.T) {
	if err := ValidatePerformanceTarget("http://user:secret@127.0.0.1:3001"); err == nil {
		t.Fatal("expected URL credentials to fail")
	}
}
