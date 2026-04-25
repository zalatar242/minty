'use strict';

const { seedE2EData } = require('./_fixtures');

module.exports = async function globalSetup() {
    seedE2EData();
};
