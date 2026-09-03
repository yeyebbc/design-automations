@echo off
setlocal

set "STAGER=%~dp0Affinity_Stage_Source_Files.ps1"
set "POWERSHELL_EXE=powershell.exe"
where pwsh.exe >nul 2>nul
if %ERRORLEVEL% EQU 0 set "POWERSHELL_EXE=pwsh.exe"

if "%~1"=="" goto :usage
if "%~2"=="" goto :usage

if "%~3"=="" (
    "%POWERSHELL_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%STAGER%" -SourcePath "%~1" -DesktopPath "%~2"
) else (
    "%POWERSHELL_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%STAGER%" -SourcePath "%~1" -DesktopPath "%~2" -ListPath "%~3"
)

set "STAGING_EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%STAGING_EXIT_CODE%"=="0" (
    echo Staging failed. Review the error above.
) else (
    echo Staging finished successfully.
    echo Run the numbered Staged_List_*_001.txt, _002.txt, etc. in order.
    echo Close all opened Affinity documents without saving between lists.
)
echo.
pause
exit /b %STAGING_EXIT_CODE%

:usage
echo Usage:
echo   %~nx0 ^<SourcePath^> ^<DesktopPath^> [ListPath]
echo.
echo Example:
echo   %~nx0 "C:\Users\example\Designs\icons" "C:\Users\example\Desktop" "C:\path\文件列表_试跑3个.txt"
echo.
pause
exit /b 2
