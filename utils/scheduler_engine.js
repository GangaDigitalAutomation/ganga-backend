/**
 * Central scheduler engine for human-like upload planning.
 * This module is intentionally shared by desktop uploader and CI uploader.
 */
const engine = require('./humanScheduler');

module.exports = {
  ...engine,
};
