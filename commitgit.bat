@echo off
cd /d C:\Users\Administrator\Desktop\discordbotnew

git add .

git commit -m "auto update at %date% %time%"

git push origin main

pause
