// lib/cluster/fixture-source.ts
// The `source` facet every fake-cluster fixture carries — every fixture
// document comes from Gallica, as worker-v2 records it. Its own module so the
// two fixture files can share it without importing each other.
export const FIXTURE_SOURCE = "gallica"
