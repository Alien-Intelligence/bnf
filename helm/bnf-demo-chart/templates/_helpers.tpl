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
