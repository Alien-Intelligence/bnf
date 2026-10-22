import "server-only"
// Empty by design: the one cross-model read the messages model needs, every
// project with the usage of its messages, is a Project-rooted query and lives
// in ProjectQueries.listWithMessageUsage (models.md: the model that owns the
// primary entity writes the join).
export class MessageQueries {}
