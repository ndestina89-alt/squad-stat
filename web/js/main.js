import { API_BASE } from '../config.js';
import { createApp } from './app.js';
import { createApi, ApiError } from './api.js';

let api = null; let configError = null;
try { api = createApi({ base: API_BASE }); } catch (e) { configError = e instanceof ApiError ? e : new ApiError('config', String(e)); }
createApp({ document, window, api, configError }).start();
