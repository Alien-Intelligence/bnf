/**
 * The broker process's configuration — parsed ONCE from process.env at
 * startup. A missing secret or rate throws here, before the listener opens.
 * Everything that needs config imports it from this module; config.ts itself
 * stays pure (loadConfig) so it is tested without process-wide state.
 */
import { loadConfig } from "./config.js";

export const config = loadConfig(process.env);

/** The authenticated partner-API host, parsed once (classification + auth). */
export const partnerApiHost: string = new URL(config.apiBaseUrl).host;
