{{/*
Expand the name of the chart.
*/}}
{{- define "bnf-demo.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "bnf-demo.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart name and version for the chart label.
*/}}
{{- define "bnf-demo.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "bnf-demo.labels" -}}
helm.sh/chart: {{ include "bnf-demo.chart" . }}
{{ include "bnf-demo.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "bnf-demo.selectorLabels" -}}
app.kubernetes.io/name: {{ include "bnf-demo.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
In-cluster DNS name of the app Service. Used both as the worker's progress
callback host (WORKER_CALLBACK_BASE_URL / APP_BASE_URL) and nowhere else —
keep the two in lock-step so the worker's callback host allow-list passes.
Port 80 is the http default, so it is intentionally omitted from the URL.
*/}}
{{- define "bnf-demo.appInternalUrl" -}}
{{- printf "http://%s.%s.svc.cluster.local" (include "bnf-demo.fullname" .) .Values.namespace }}
{{- end }}

{{/*
In-cluster DNS name of the worker HTTP API (app → worker job submit).
*/}}
{{- define "bnf-demo.workerInternalUrl" -}}
{{- printf "http://%s-worker.%s.svc.cluster.local:%d" (include "bnf-demo.fullname" .) .Values.namespace (int .Values.worker.service.port) }}
{{- end }}

{{/*
In-cluster DNS name of the BnF broker (app resolver + worker → broker /fetch).
The broker is the SINGLE egress chokepoint for all BnF traffic; both the app
and the worker point BNF_BROKER_URL here so the shared rate caps are honoured.
*/}}
{{- define "bnf-demo.brokerInternalUrl" -}}
{{- printf "http://%s-broker.%s.svc.cluster.local:%d" (include "bnf-demo.fullname" .) .Values.namespace (int .Values.broker.service.port) }}
{{- end }}

{{/*
A numeric chart value: a YAML number, or a string holding one (`--set-string`,
a quoted "60000"), returned as text for float64/int64. Anything else fails the
render, naming the value and what it must be.
Usage: {{ include "bnf-demo.numberValue" (dict "value" $v "name" "replicaCount" "what" "a whole number >= 1") }}
*/}}
{{- define "bnf-demo.numberValue" -}}
{{- $v := .value -}}
{{- if or (kindIs "int" $v) (kindIs "int64" $v) (kindIs "float64" $v) -}}
{{- $v -}}
{{- else if and (kindIs "string" $v) (regexMatch "^-?[0-9]+(\\.[0-9]+)?$" (trim $v)) -}}
{{- trim $v -}}
{{- else -}}
{{- fail (printf "%s must be %s (got %q)" .name .what (toString $v)) -}}
{{- end -}}
{{- end -}}

{{/*
One replica's share of a BnF MCP per-minute rate (config.bnfMcpRate.<key>),
for the app-side limiter (lib/mcp/rate-limit.ts). The limiters live in process
memory, so each replica gets rate / replicaCount and the fleet stays under the
BnF quota. The value is REQUIRED (the app has no code default). Each failure
names its own cause: a rate that is not a whole number >= 1, a replica count
that is not a whole number >= 1, and — only for valid values — a share below
1/min (flooring it up to 1 would put the fleet over the quota, which is the
2026-09-30 incident).
Usage: {{ include "bnf-demo.bnfRateShare" (dict "root" . "key" "catalogueRpm") }}
*/}}
{{- define "bnf-demo.bnfRateShare" -}}
{{- $name := printf "config.bnfMcpRate.%s" .key -}}
{{- $what := "a whole number of requests per minute >= 1" -}}
{{- $raw := required (printf "%s is required" $name) (index .root.Values.config.bnfMcpRate .key) -}}
{{- $rate := float64 (include "bnf-demo.numberValue" (dict "value" $raw "name" $name "what" $what)) -}}
{{- if or (lt $rate 1.0) (ne $rate (floor $rate)) -}}
{{- fail (printf "%s must be %s (got %v)" $name $what $rate) -}}
{{- end -}}
{{- $replicasRaw := required "replicaCount is required" .root.Values.replicaCount -}}
{{- $replicas := float64 (include "bnf-demo.numberValue" (dict "value" $replicasRaw "name" "replicaCount" "what" "a whole number >= 1")) -}}
{{- if or (lt $replicas 1.0) (ne $replicas (floor $replicas)) -}}
{{- fail (printf "replicaCount must be a whole number >= 1 (got %v)" $replicas) -}}
{{- end -}}
{{- $share := div (int64 $rate) (int64 $replicas) -}}
{{- if lt (int64 $share) 1 -}}
{{- fail (printf "%s=%v split over %v replicas is below 1/min — lower replicaCount or move the limiter to a shared store" $name $rate $replicas) -}}
{{- end -}}
{{- $share -}}
{{- end -}}

{{/*
config.bnfMcpRate.maxWaitMs, checked at render time against the app's boot
rule (lib/env.ts: an integer in 1..BNF_MCP_RATE_MAX_WAIT_MS_CEILING = 60000),
so a bad value fails `helm template` instead of crash-looping the pod. A
numeric string ("60000") is a number.
*/}}
{{- define "bnf-demo.bnfMaxWaitMs" -}}
{{- $what := "a whole number of milliseconds in 1..60000" -}}
{{- $raw := required "config.bnfMcpRate.maxWaitMs is required" .Values.config.bnfMcpRate.maxWaitMs -}}
{{- $wait := float64 (include "bnf-demo.numberValue" (dict "value" $raw "name" "config.bnfMcpRate.maxWaitMs" "what" $what)) -}}
{{- if or (lt $wait 1.0) (gt $wait 60000.0) (ne $wait (floor $wait)) -}}
{{- fail (printf "config.bnfMcpRate.maxWaitMs must be %s (got %v)" $what $wait) -}}
{{- end -}}
{{- int64 $wait -}}
{{- end -}}
