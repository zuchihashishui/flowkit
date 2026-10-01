# Retry video generation
$body = @'
{
  "requests": [
    {"type": "GENERATE_VIDEO", "scene_id": "f202edc0-aaaf-4e68-a09c-52222d5b4e66", "project_id": "80f6ddfe-e4ee-4fdf-af8a-ede0fd34529a", "video_id": "1ca9a76d-4597-4796-b790-b426f8781d5e"},
    {"type": "GENERATE_VIDEO", "scene_id": "e6c3dfc2-4886-4dec-9cef-a7ff77fb107e", "project_id": "80f6ddfe-e4ee-4fdf-af8a-ede0fd34529a", "video_id": "1ca9a76d-4597-4796-b790-b426f8781d5e"},
    {"type": "GENERATE_VIDEO", "scene_id": "b146eebf-e9ad-4818-84d9-6cf67a43f7f5", "project_id": "80f6ddfe-e4ee-4fdf-af8a-ede0fd34529a", "video_id": "1ca9a76d-4597-4796-b790-b426f8781d5e"}
  ]
}
'@

Write-Host "Submitting video batch..." -ForegroundColor Cyan
$result = Invoke-RestMethod -Uri "http://127.0.0.1:8100/api/requests/batch" -Method POST -Body $body -ContentType "application/json"
Write-Host "Submitted $($result.Count) requests" -ForegroundColor Green

Write-Host "Monitoring progress..." -ForegroundColor Cyan
$maxWait = 300
$elapsed = 0

while ($elapsed -lt $maxWait) {
    Start-Sleep -Seconds 15
    $elapsed += 15
    
    $params = @{
        Uri = "http://127.0.0.1:8100/api/requests/batch-status"
        Method = "Get"
        Body = @{
            video_id = "1ca9a76d-4597-4796-b790-b426f8781d5e"
            type = "GENERATE_VIDEO"
        }
    }
    $status = Invoke-RestMethod @params
    
    Write-Host "[$elapsed s] Total: $($status.total) | Pending: $($status.pending) | Processing: $($status.processing) | Completed: $($status.completed) | Failed: $($status.failed)"
    
    if ($status.done) {
        if ($status.all_succeeded) {
            Write-Host "All videos completed!" -ForegroundColor Green
        } else {
            Write-Host "Some videos failed." -ForegroundColor Red
        }
        break
    }
}
