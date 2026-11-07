// /api/auth/* handler. Created lazily so `next build` does not need runtime secrets.
import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from './auth';

let handlers: ReturnType<typeof toNextJsHandler> | undefined;
const get = () => (handlers ??= toNextJsHandler(auth()));

export const GET = (req: Request) => get().GET(req);
export const POST = (req: Request) => get().POST(req);
