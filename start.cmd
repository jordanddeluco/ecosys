@echo off
rem Double-click to start ecosys. It opens your browser with the pairing link, which connects that
rem browser to your data (the link is also shown in this window; open it once in any other browser).
rem Closing this window stops ecosys.
title ecosys
cd /d "%~dp0"
node server.mjs --open
pause
