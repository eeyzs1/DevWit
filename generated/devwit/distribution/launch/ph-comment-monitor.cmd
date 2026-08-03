@echo off
cd /d e:\AI_Generated_Projects\DevWit\generated\devwit
REM 不重定向 stdout 到 log：脚本内 log() 已用 appendFileSync 写日志（含 EBUSY 重试）。
REM 双写（stdout 重定向 + appendFileSync）会争抢同一文件句柄导致 EBUSY，日志静默丢失。
REM stderr 单独捕获到 err 文件，便于诊断未捕获的原生崩溃（与主日志分离，不争抢句柄）。
node distribution/launch/ph-comment-monitor.cjs 2> distribution/launch/evidence/ph-comment-monitor.err.log
