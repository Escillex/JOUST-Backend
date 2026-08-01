// The application refuses to start without a real JWT_SECRET (plan 7.7), so the
// test environment must supply one. Without this every suite that touches auth
// or the realtime gateway fails on a configuration error rather than on the
// behaviour it is actually asserting.
//
// This value is for tests only and never leaves the process.
process.env.JWT_SECRET =
  process.env.JWT_SECRET ||
  'test-only-secret-K3f9wQ2mZp8vN1xR7tY4uB6cA0sD5gH2jL9k';
