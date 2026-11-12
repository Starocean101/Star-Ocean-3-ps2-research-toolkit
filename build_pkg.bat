@echo off
setlocal EnableExtensions
REM ------------------------------------------------------------------
REM  Builds UP0001-CUSA99901_00-STAROCEANUTILITY-A0100-V0100.pkg
REM  using orbis-pub-cmd.exe from PS4-Fake-PKG-Tools-3.87.
REM
REM  Usage:  build_pkg.bat  [path\to\PS4-Fake-PKG-Tools-3.87-main]
REM  (or double-click and paste the folder path when asked)
REM ------------------------------------------------------------------
cd /d "%~dp0"
set "HERE=%~dp0"
set "CID=UP0001-CUSA99901_00-STAROCEANUTILITY"
set "PASS=00000000000000000000000000000000"

set "TOOLS=%~1"
if "%TOOLS%"=="" set "TOOLS=%HERE%..\PS4-Fake-PKG-Tools-3.87-main"
if not exist "%TOOLS%\orbis-pub-cmd.exe" set "TOOLS=%HERE%PS4-Fake-PKG-Tools-3.87-main"
if not exist "%TOOLS%\orbis-pub-cmd.exe" (
    echo Could not find orbis-pub-cmd.exe.
    set /p "TOOLS=Paste the path of your PS4-Fake-PKG-Tools-3.87-main folder: "
)
set "TOOLS=%TOOLS:"=%"
set "PUB=%TOOLS%\orbis-pub-cmd.exe"
if not exist "%PUB%" ( echo ERROR: "%PUB%" not found. & pause & exit /b 1 )

if not exist "%HERE%out" mkdir "%HERE%out"
if not exist "%HERE%tmp" mkdir "%HERE%tmp"

echo.
echo [1/2] Building PKG from pkg.gp4 ...
"%PUB%" img_create --oformat pkg --skip_digest --no_progress_bar --tmp_path "%HERE%tmp" "%HERE%pkg.gp4" "%HERE%out"
if not errorlevel 1 goto done

echo.
echo First attempt failed - regenerating the project with absolute paths ...
set "GP4=%HERE%tmp\abs.gp4"
if exist "%GP4%" del "%GP4%"
"%PUB%" gp4_proj_create --volume_type pkg_ps4_app --storage_type digital50 --app_type full --content_id %CID% --passcode %PASS% "%GP4%" || goto fail
"%PUB%" gp4_file_add "%HERE%eboot.bin"                  eboot.bin                  "%GP4%" || goto fail
"%PUB%" gp4_file_add "%HERE%sce_sys\param.sfo"          sce_sys/param.sfo          "%GP4%" || goto fail
"%PUB%" gp4_file_add "%HERE%sce_sys\icon0.png"          sce_sys/icon0.png          "%GP4%" || goto fail
"%PUB%" gp4_file_add "%HERE%sce_sys\about\right.sprx"   sce_sys/about/right.sprx   "%GP4%" || goto fail
"%PUB%" gp4_file_add "%HERE%sce_module\libc.prx"        sce_module/libc.prx        "%GP4%" || goto fail
"%PUB%" gp4_file_add "%HERE%sce_module\libSceFios2.prx" sce_module/libSceFios2.prx "%GP4%" || goto fail
"%PUB%" gp4_file_add "%HERE%assets\bg.bin"              assets/bg.bin              "%GP4%" || goto fail
"%PUB%" gp4_file_add "%HERE%assets\music.pcm"           assets/music.pcm           "%GP4%" || goto fail
echo [2/2] Building PKG ...
"%PUB%" img_create --oformat pkg --skip_digest --no_progress_bar --tmp_path "%HERE%tmp" "%GP4%" "%HERE%out" || goto fail

:done
echo.
echo SUCCESS - your package is in:
dir /b "%HERE%out\*.pkg"
echo   %HERE%out
echo.
echo Install it on the PS4 with GoldHEN's Package Installer (Debug Settings),
echo or Remote PKG Installer.
pause
exit /b 0

:fail
echo.
echo PKG build FAILED. Check the messages above.
echo Tip: run Temp-Folder-Patcher.bat from the Fake PKG Tools folder if you see temp errors.
pause
exit /b 1
