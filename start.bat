@echo off
cd /d %~dp0
echo Starting Sentence Bank...
echo If this is your first run, please wait for npm to finish.
npm install
npm run start
pause
