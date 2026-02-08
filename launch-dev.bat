@echo off
echo Closing any running Craft Agents instances...
taskkill /F /IM "Craft Agents.exe" >nul 2>&1
timeout /t 2 /nobreak >nul

echo Starting Craft Agents with Agent Teams...
cd /d "%~dp0"
bun run electron:dev
