export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

export function assertUser(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new UserError(message);
  }
}
