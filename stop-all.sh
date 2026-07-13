#!/usr/bin/env bash
# stop-all.sh — tear down Kontrol + tunnel + ACP adapters
echo "[*] Stopping kontrol + tunnel-client + ACP adapters ..."
tmux kill-session -t kontrol-server 2>/dev/null || true
tmux kill-session -t kontrol-tunnel 2>/dev/null || true
tmux kill-session -t kontrol-adapter 2>/dev/null || true
tmux kill-session -t kontrol-adapter-crush 2>/dev/null || true
tmux kill-session -t kontrol-adapter-hermes 2>/dev/null || true
pkill -9 -f "cli.js serve" 2>/dev/null || true
pkill -9 -f "tunnel-client" 2>/dev/null || true
pkill -9 -f "acp-crush-adapter.mjs" 2>/dev/null || true
pkill -9 -f "acp-hermes-native-adapter.mjs" 2>/dev/null || true
echo "[*] Done."
