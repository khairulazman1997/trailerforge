import { ServiceClient } from '@trailerforge/service/client';
import type { Connection } from './connection.js';

export const makeClient = (c: Connection) =>
  new ServiceClient({ baseUrl: c.baseUrl, token: c.token });
