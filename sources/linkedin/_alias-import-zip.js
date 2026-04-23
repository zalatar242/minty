// sources/linkedin/_alias-import-zip.js
process.stderr.write(
  "[deprecated] The 'linkedin' script has been renamed to 'linkedin:import-zip'.\n" +
  "             Update your scripts/cron to use 'npm run linkedin:import-zip'.\n" +
  "             The 'linkedin' alias will be removed in v0.4.\n\n"
);
require('./import.js');
