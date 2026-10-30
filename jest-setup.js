// Jest setup provided by Grafana scaffolding
import './.config/jest-setup';
import { setImmediate } from 'timers';

// jsdom has no setImmediate, so React's scheduler falls back to a MessageChannel port that keeps Jest from
// exiting; with setImmediate available the scheduler uses it instead.
Object.assign(global, { setImmediate });
