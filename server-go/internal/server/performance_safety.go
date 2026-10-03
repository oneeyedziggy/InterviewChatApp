package server

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const PerformanceDataMarker = ".interview-chat-performance-data"

var performanceRunIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

func ValidatePerformanceEnvironment(dataDir string) error {
	if strings.TrimSpace(os.Getenv("PERFORMANCE_TEST_MODE")) != "1" {
		return nil
	}

	runID := strings.TrimSpace(os.Getenv("PERFORMANCE_RUN_ID"))
	if !performanceRunIDPattern.MatchString(runID) {
		return fmt.Errorf("PERFORMANCE_RUN_ID must match %s", performanceRunIDPattern.String())
	}
	if strings.TrimSpace(os.Getenv("SERVER_DATA_DIR")) == "" {
		return fmt.Errorf("SERVER_DATA_DIR is required in performance test mode")
	}

	absoluteDataDir, err := filepath.Abs(dataDir)
	if err != nil {
		return fmt.Errorf("resolve performance data directory: %w", err)
	}
	info, err := os.Stat(absoluteDataDir)
	if err != nil {
		return fmt.Errorf("inspect performance data directory: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("performance data path is not a directory: %s", absoluteDataDir)
	}

	markerPath := filepath.Join(absoluteDataDir, PerformanceDataMarker)
	marker, err := os.ReadFile(markerPath)
	if err != nil {
		return fmt.Errorf("read performance data marker %s: %w", markerPath, err)
	}
	if strings.TrimSpace(string(marker)) != runID {
		return fmt.Errorf("performance data marker does not match PERFORMANCE_RUN_ID")
	}
	return nil
}

func ValidatePerformanceTarget(rawURL string) error {
	target, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || target.Scheme == "" || target.Host == "" {
		return fmt.Errorf("performance target must be an absolute URL")
	}
	if target.Scheme != "http" && target.Scheme != "https" && target.Scheme != "ws" && target.Scheme != "wss" {
		return fmt.Errorf("unsupported performance target scheme %q", target.Scheme)
	}
	if target.User != nil {
		return fmt.Errorf("performance target URL must not contain credentials")
	}
	hostname := strings.ToLower(target.Hostname())
	if hostname == "localhost" {
		return nil
	}
	if address := net.ParseIP(hostname); address != nil && address.IsLoopback() {
		return nil
	}
	if strings.TrimSpace(os.Getenv("PERF_ALLOW_REMOTE")) != "1" {
		return fmt.Errorf("remote target %s requires PERF_ALLOW_REMOTE=1", hostname)
	}
	for _, allowed := range strings.Split(os.Getenv("PERF_ALLOWED_HOSTS"), ",") {
		if strings.EqualFold(strings.TrimSpace(allowed), hostname) {
			return nil
		}
	}
	return fmt.Errorf("remote target %s is not in PERF_ALLOWED_HOSTS", hostname)
}
