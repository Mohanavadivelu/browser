'use strict';

const { app } = require('electron');
const { start } = require('./app');

start().catch((error) => {
  console.error(error);
  app.exit(1);
});
