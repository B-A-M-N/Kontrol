#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { correlateHostStreamEvidence } from "./lib/mcp-stream-correlation.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const harPath = option("--har", undefined);
const kontrolLogPath = option("--kontrol-log", undefined);
const diagnosticsPath = option("--diagnostics", undefined);
const tunnelLogPath = option("--tunnel-log", undefined);
const outputPath = option("--output", undefined);
const windowMs = Number(option("--window-ms", "5000"));
const urlPattern = option("--url-pattern", "/backend-api/conversation");
if (!harPath) throw new Error("Usage: analyze-mcp-stream-failure.mjs --har HAR.json [--kontrol-log LOG.jsonl] [--diagnostics DIAGNOSTICS.json] [--tunnel-log LOG.jsonl] [--output PATH]");

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function readJsonLines(path) {
  if (!path) return [];
  return readFileSync(resolve(path), "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

const har = readJson(harPath);
const kontrolRecords = readJsonLines(kontrolLogPath);
if (diagnosticsPath) {
  const diagnostics = readJson(diagnosticsPath);
  const recent = diagnostics?.mcpSessionMetrics?.operationDiagnostics?.recent;
  if (Array.isArray(recent)) kontrolRecords.push(...recent);
}
const report = correlateHostStreamEvidence({
  har,
  kontrolRecords,
  tunnelRecords: readJsonLines(tunnelLogPath),
  windowMs,
  urlPattern,
});
const json = JSON.stringify(report, null, 2) + "\n";
if (outputPath) writeFileSync(resolve(outputPath), json, { mode: 0o600 });
else process.stdout.write(json);
