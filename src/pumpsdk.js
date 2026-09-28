// The pump SDK's ESM build has a broken import, so load its CommonJS build.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const sdk = require('@pump-fun/pump-sdk');
export default sdk;
export const swap = require('@pump-fun/pump-swap-sdk');
