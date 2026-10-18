param(
    [ValidateSet('Windows', 'WSL')][string]$Cliente,
    [string]$Distro = 'Ubuntu',
    [switch]$Atualizar
)
$ErrorActionPreference = 'Stop'

function Run-Checked {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Falha em $Program (codigo $LASTEXITCODE). Confira a saida acima e execute novamente." }
}

try {
    if (-not $Atualizar -and -not $Cliente) {
        Write-Host 'Onde voce vai usar o OpenCode? O backend Docker roda no WSL 2 nos dois casos.'
        Write-Host '1. Windows / PowerShell'
        Write-Host '2. WSL'
        $choice = Read-Host 'Escolha 1 ou 2'
        if ($choice -notin @('1', '2')) { throw 'Escolha invalida.' }
        $Cliente = if ($choice -eq '1') { 'Windows' } else { 'WSL' }
    }

    $distros = @()
    if (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
        $distros = @((& wsl.exe --list --quiet 2>$null) -replace "`0", '' | ForEach-Object { $_.Trim() })
    }
    if ($Distro -notin $distros) {
        Write-Host "Instalando WSL 2 com $Distro. O Windows pode solicitar elevacao e reinicializacao."
        $process = Start-Process wsl.exe -ArgumentList @('--install', '-d', $Distro, '--no-launch') -Verb RunAs -Wait -PassThru
        if ($process.ExitCode -notin @(0, 3010)) { throw 'A instalacao do WSL falhou.' }
        Write-Host "Abra $Distro e conclua a criacao do usuario Linux. Reinicie o Windows se solicitado e execute este script novamente."
        exit 3
    }

    $linuxUser = & wsl.exe -d $Distro --exec id -u
    if ($LASTEXITCODE -ne 0 -or "$linuxUser".Trim() -eq '0') { throw "Abra $Distro e configure um usuario Linux normal com sudo antes de continuar." }

    # A cloned checkout (including paths with spaces) is used directly. The
    # standalone launcher clones the official repository into the Linux home.
    if (Test-Path (Join-Path $PSScriptRoot 'instalar-opencode.py')) {
        $project = & wsl.exe -d $Distro --exec wslpath -a -u $PSScriptRoot
        if ($LASTEXITCODE -ne 0) { throw 'Nao consegui converter o caminho do projeto para WSL.' }
        $project = "$project".Trim()
    } else {
        $bootstrap = 'set -eu; if ! command -v git >/dev/null; then sudo apt-get update; sudo apt-get install -y git ca-certificates; fi; dest="$HOME/muse-web-opencode-bridge"; if [ ! -d "$dest" ]; then git clone https://github.com/sniperpsp/muse-web-opencode-bridge.git "$dest"; fi'
        Run-Checked 'wsl.exe' @('-d', $Distro, '--exec', 'bash', '-c', $bootstrap)
        $linuxHome = & wsl.exe -d $Distro --exec printenv HOME
        if ($LASTEXITCODE -ne 0) { throw 'Nao consegui localizar o home do WSL.' }
        $project = "$linuxHome".Trim() + '/muse-web-opencode-bridge'
    }

    $installerArgs = @()
    if ($Atualizar) {
        $installerArgs += '--update'
    } elseif ($Cliente -eq 'Windows') {
        if (-not (Get-Command opencode -ErrorAction SilentlyContinue)) {
            if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
                if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) { throw 'Instale o App Installer (winget) pela Microsoft Store e execute novamente.' }
                Run-Checked 'winget.exe' @('install', '--id', 'OpenJS.NodeJS.LTS', '--exact', '--accept-package-agreements', '--accept-source-agreements')
                $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
            }
            Run-Checked 'npm.cmd' @('install', '-g', '@opencode/cli')
            $env:Path += ';' + (Join-Path $env:APPDATA 'npm')
        }
        $opencodeCmd = (Get-Command opencode.cmd -ErrorAction SilentlyContinue)
        if (-not $opencodeCmd) { $opencodeCmd = Get-Command opencode }
        $version = & $opencodeCmd.Source --version
        if ($LASTEXITCODE -ne 0) { throw 'Nao consegui consultar a versao do OpenCode Windows.' }
        $windowsConfig = Join-Path $env:USERPROFILE '.config\opencode'
        $linuxConfig = & wsl.exe -d $Distro --exec wslpath -a -u $windowsConfig
        if ($LASTEXITCODE -ne 0) { throw 'Nao consegui converter o caminho da configuracao Windows.' }
        $installerArgs += @('--config-dir', "$linuxConfig".Trim(), '--opencode-version', "$version".Trim())
    }
    Run-Checked 'wsl.exe' (@('-d', $Distro, '--exec', 'bash', "$project/instalar.sh") + $installerArgs)
    if (-not $Atualizar -and $Cliente -eq 'Windows') {
        $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        Get-ChildItem -LiteralPath $windowsConfig -File | Where-Object { $_.Name -match '^opencode\.jsonc?(\.pre-muse-.*)?$' } | ForEach-Object {
            $acl = New-Object System.Security.AccessControl.FileSecurity
            $acl.SetOwner($sid)
            $acl.SetAccessRuleProtection($true, $false)
            $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
            $acl.AddAccessRule($rule)
            Set-Acl -LiteralPath $_.FullName -AclObject $acl
        }
    }
    Write-Host 'Concluido. Abra http://127.0.0.1:4317 e autentique sua conta Muse.'
} catch {
    Write-Error $_
    exit 1
}
