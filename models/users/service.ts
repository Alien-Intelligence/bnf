import "server-only"

// Better-auth owns all User mutations (sign-up, sign-in, password reset).
// This service class is intentionally empty — it exists to satisfy the
// five-file model convention (playbook/models.md) and to serve as the
// extension point when app-level user mutations are needed in a later slice.
export class UserService {}
