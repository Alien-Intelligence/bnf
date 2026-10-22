import "server-only"
// Stub — the cache is written and read by background drains only, never by a
// request on behalf of a user, so there is no authorization decision to make.
export class BnfRecordPolicy {}
