/**
 * Physical CLI pack (ET-A3 / #123).
 *
 * Thin Mission CLI shell: parse argv, resolve models/resources, call the
 * mission API. Not a second control plane — authorize / continue / repair /
 * stop live in `src/mission/`.
 */
export * from "./evok-cli";
