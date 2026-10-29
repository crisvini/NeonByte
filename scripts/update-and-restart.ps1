$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$taskName = 'NeonByte Agent'
$taskPath = '\'
$stage = 'verificação inicial'
$stopped = $false
$buildSucceeded = $false
$started = $false
$commit = 'indisponível'

function Invoke-CheckedCommand {
    param([string]$Command, [string[]]$Arguments, [string]$Failure)
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = & $Command @Arguments 2>&1
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($code -ne 0) { throw $Failure }
    return $output
}

function Get-AgentProcesses {
    $entryPoint = Join-Path $root 'agent\dist\main.js'
    $pattern = '(?i)(?:^|\s)"?' + [regex]::Escape($entryPoint) + '"?\s+run(?:\s|$)'
    $processes = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)
    foreach ($process in $processes) {
        if ($null -eq $process.CommandLine) { throw 'Não foi possível verificar a linha de comando de todos os processos Node.js.' }
        if ($process.CommandLine -match $pattern) { $process }
    }
}

function Wait-AgentExit {
    param([int]$Seconds)
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        if (@(Get-AgentProcesses).Count -eq 0) { return $true }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Assert-TaskMatchesCheckout {
    $tasks = @(Get-ScheduledTask -TaskName $taskName -ErrorAction Stop | Where-Object { $_.TaskPath -eq $taskPath })
    if ($tasks.Count -ne 1) { throw 'A tarefa NeonByte Agent não foi encontrada na raiz do Agendador. Consulte docs/installation.md para configurar a inicialização.' }
    $task = $tasks[0]
    $launcher = Join-Path $root 'agent\startup\windows-hidden.vbs'
    $expectedArguments = '^//B\s+//NoLogo\s+"' + [regex]::Escape($launcher) + '"\s+"[^"\r\n]+"$'
    $expectedExecutable = Join-Path $env:SystemRoot 'System32\wscript.exe'
    if (@($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -ine $expectedExecutable -or $task.Actions[0].Arguments -notmatch $expectedArguments) {
        throw 'A tarefa NeonByte Agent não corresponde ao inicializador deste repositório. Confira sua ação no Agendador e consulte docs/installation.md.'
    }
    return $task
}

try {
    Set-Location -LiteralPath $root
    Write-Host 'Verificando ferramentas e tarefa agendada...'
    foreach ($tool in @('git.exe', 'node.exe', 'npm.cmd')) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Ferramenta não encontrada: $tool." }
    }
    try { $null = Assert-TaskMatchesCheckout } catch {
        if ($_.Exception.Message -match 'não corresponde|não foi encontrada') { throw }
        throw 'Não foi possível acessar a tarefa NeonByte Agent. Confira sua existência e consulte docs/installation.md.'
    }
    $null = Get-AgentProcesses
    $stage = 'verificação do repositório'
    $status = @(Invoke-CheckedCommand 'git' @('status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none') 'Não foi possível verificar o estado do repositório.')
    if ($status.Count -gt 0) { throw 'O repositório contém alterações locais ou arquivos não rastreados. Revise-os antes de atualizar.' }
    $trackedFiles = @(Invoke-CheckedCommand 'git' @('ls-files', '-v') 'Não foi possível verificar os arquivos rastreados.')
    if (@($trackedFiles | Where-Object { $_ -cmatch '^[a-zS] ' }).Count -gt 0) { throw 'Há arquivos marcados para ocultar alterações do Git. Revise essas marcações antes de atualizar.' }
    foreach ($operation in @('MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG', 'sequencer')) {
        $operationPath = @(Invoke-CheckedCommand 'git' @('rev-parse', '--git-path', $operation) 'Não foi possível verificar operações Git em andamento.')[0]
        if (Test-Path -LiteralPath $operationPath) { throw 'Há uma operação Git em andamento. Conclua-a ou cancele-a antes de atualizar.' }
    }
    $branch = @(Invoke-CheckedCommand 'git' @('rev-parse', '--abbrev-ref', 'HEAD') 'Não foi possível identificar a branch atual.')[0]
    if ($branch -eq 'HEAD') { throw 'O repositório está em estado detached HEAD. Resolva essa condição antes de atualizar.' }
    $null = Invoke-CheckedCommand 'git' @('rev-parse', '--verify', 'refs/heads/main') 'A branch local main não existe. Configure-a antes de atualizar.'
    $stage = 'busca de atualizações'
    Write-Host 'Buscando origin/main...'
    $null = Invoke-CheckedCommand 'git' @('fetch', '--no-tags', 'origin', 'refs/heads/main:refs/remotes/origin/main') 'A busca de origin/main falhou.'
    $null = Invoke-CheckedCommand 'git' @('merge-base', '--is-ancestor', 'refs/heads/main', 'refs/remotes/origin/main') 'A main local divergiu ou contém commits locais. Resolva a divergência antes de atualizar.'
    if ($branch -ne 'main') {
        $null = Invoke-CheckedCommand 'git' @('switch', '--no-overwrite-ignore', 'main') 'Não foi possível mudar para main sem risco de sobrescrever arquivos.'
    }
    $stage = 'atualização da main'
    $null = Invoke-CheckedCommand 'git' @('merge', '--ff-only', '--no-overwrite-ignore', 'refs/remotes/origin/main') 'Não foi possível atualizar main por avanço rápido sem sobrescrever arquivos.'
    $commit = @(Invoke-CheckedCommand 'git' @('rev-parse', 'HEAD') 'Não foi possível identificar o commit implantado.')[0]
    $null = Assert-TaskMatchesCheckout
    $stage = 'parada do agente'
    Write-Host 'Parando a tarefa e aguardando o agente...'
    $stopped = $true
    Stop-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop
    if (-not (Wait-AgentExit 10)) {
        foreach ($process in @(Get-AgentProcesses)) {
            $current = @(Get-AgentProcesses | Where-Object { $_.ProcessId -eq $process.ProcessId })
            if ($current.Count -eq 1) { Stop-Process -Id $process.ProcessId -ErrorAction Stop }
        }
        if (-not (Wait-AgentExit 10)) { throw 'O processo do agente não terminou dentro do prazo.' }
    }
    if ((Assert-TaskMatchesCheckout).State -eq 'Running') { throw 'A tarefa ainda está em execução; aguarde sua parada antes de tentar novamente.' }
    $stage = 'instalação das dependências'
    Write-Host 'Instalando dependências a partir dos lockfiles...'
    $null = Invoke-CheckedCommand 'npm.cmd' @('ci') 'A instalação das dependências da raiz falhou.'
    $null = Invoke-CheckedCommand 'npm.cmd' @('ci', '--prefix', 'agent') 'A instalação das dependências do agente falhou.'
    if (@(Get-AgentProcesses).Count -ne 0) { throw 'Um processo do agente foi iniciado durante a instalação. Interrompa-o antes de compilar.' }
    $stage = 'compilação do agente'
    Write-Host 'Compilando o agente...'
    $null = Invoke-CheckedCommand 'npm.cmd' @('--prefix', 'agent', 'run', 'build') 'A compilação do agente falhou.'
    $buildSucceeded = $true
    $stage = 'inicialização do agente'
    $null = Assert-TaskMatchesCheckout
    Write-Host 'Iniciando a tarefa e verificando o painel...'
    Start-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop
    $started = $true
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    $healthy = $false
    do {
        $agentIds = @(Get-AgentProcesses | ForEach-Object { [int]$_.ProcessId })
        $listeners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue)
        if (@($listeners | Where-Object { $agentIds -contains [int]$_.OwningProcess }).Count -gt 0) {
            try {
                $response = Invoke-WebRequest -Uri 'http://127.0.0.1:8787/' -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
                if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) { $healthy = $true; break }
            } catch { }
        }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $healthy) { throw 'O painel não respondeu pelo processo deste repositório dentro do prazo.' }
    Write-Host "Atualização concluída. Commit: $commit. Agente: em execução; painel respondendo."
    exit 0
} catch {
    Write-Host "Falha na etapa: $stage. $($_.Exception.Message)"
    Write-Host "Commit atual: $commit."
    if ($stopped -and -not $buildSucceeded) {
        Write-Host 'O agente não foi reiniciado. Resolva a falha, confirme que a tarefa e o processo estão parados, execute npm ci, npm ci --prefix agent e npm --prefix agent run build; somente após sucesso, inicie NeonByte Agent no Agendador.'
    } elseif ($started) {
        Write-Host 'A tarefa foi iniciada, mas a verificação falhou. Confira o Agendador e %LOCALAPPDATA%\NeonByte\agent.log; revise dados sensíveis antes de compartilhar o log.'
    } elseif ($buildSucceeded) {
        Write-Host 'A compilação terminou, mas a tarefa não foi iniciada. Confira a tarefa no Agendador antes de iniciá-la.'
    } else {
        Write-Host 'A tarefa não foi parada pelo script. Corrija o problema e tente novamente.'
    }
    exit 1
}
