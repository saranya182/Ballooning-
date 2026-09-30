@echo off
title Public Deployment - Pragmatic Ballooning
echo === Pragmatic Ballooning - Public Deployment ===
echo.
echo Starting Backend and Frontend Server...
start "Backend - Pragmatic Ballooning" cmd /k "title Backend Server && cd backend && node server.js"

echo Starting OCR Service...
start "OCR - Pragmatic Ballooning" cmd /k "title OCR Service && cd backend && python ocr_service.py"

echo.
echo Waiting for services to initialize...
timeout /t 5 /nobreak >nul

echo.
echo Generating public link...
echo ========================================================
echo Please look for the URL ending in ".lhr.life" below.
echo You can share that link with anyone to access the app!
echo ========================================================
echo.
ssh -o StrictHostKeyChecking=accept-new -R 80:localhost:5000 nokey@localhost.run

pause
