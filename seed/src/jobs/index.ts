import { register } from '../scheduler.js';
import { DAILY_CIRCULATION, dailyCirculation } from './daily-circulation.js';

register(DAILY_CIRCULATION, dailyCirculation);
