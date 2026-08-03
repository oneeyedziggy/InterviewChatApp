package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestGenerateOrLoadServerKeys(t *testing.T) {
	originalDir, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd failed: %v", err)
	}
	workDir := t.TempDir()
	if err := os.Chdir(workDir); err != nil {
		t.Fatalf("Chdir failed: %v", err)
	}
	t.Cleanup(func() {
		_ = os.Chdir(originalDir)
	})

	keyRing, publicKey, err := generateOrLoadServerKeys()
	if err != nil {
		t.Fatalf("generateOrLoadServerKeys generation path failed: %v", err)
	}
	if keyRing == nil || publicKey == "" {
		t.Fatal("expected generated key material")
	}
	if _, err := os.Stat(filepath.Join(workDir, "server-gpg-key.asc")); err != nil {
		t.Fatalf("expected public key file to exist: %v", err)
	}
	if _, err := os.Stat(filepath.Join(workDir, "server-gpg-private-key.asc")); err != nil {
		t.Fatalf("expected private key file to exist: %v", err)
	}

	loadedKeyRing, loadedPublicKey, err := generateOrLoadServerKeys()
	if err != nil {
		t.Fatalf("generateOrLoadServerKeys load path failed: %v", err)
	}
	if loadedKeyRing == nil || loadedPublicKey != publicKey {
		t.Fatal("expected load path to reuse generated key material")
	}
}
