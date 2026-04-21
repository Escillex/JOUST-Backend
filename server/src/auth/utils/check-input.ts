export function isEmail(identifier: string): boolean {
  return identifier.includes('@');
}

export function isUsername(identifier: string): boolean {
  return !identifier.includes('@');
}
