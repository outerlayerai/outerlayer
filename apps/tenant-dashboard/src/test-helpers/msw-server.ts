import { setupServer } from 'msw/node';
import { mswHandlers } from './msw-handlers';

export const server = setupServer(...mswHandlers);
