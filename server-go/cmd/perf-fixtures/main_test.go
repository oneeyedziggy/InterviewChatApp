package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestSafeOutputPathStaysWithinDataDirectory(t *testing.T) {
	dataDir := t.TempDir()
	path, err := safeOutputPath(dataDir, "actors/fixtures.json")
	if err != nil {
		t.Fatalf("safeOutputPath failed: %v", err)
	}
	if path != filepath.Join(dataDir, "actors", "fixtures.json") {
		t.Fatalf("unexpected output path: %s", path)
	}
	if _, err := safeOutputPath(dataDir, filepath.Join("..", "fixtures.json")); err == nil {
		t.Fatal("expected path escape to fail")
	}
}

func TestWriteManifestUsesPrivatePermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fixtures.json")
	if err := writeManifest(path, manifest{Version: 1}); err != nil {
		t.Fatalf("writeManifest failed: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat manifest: %v", err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("manifest permissions are too broad: %o", info.Mode().Perm())
	}
}
