# Administracion de cuentas de usuario en Windows

Esta practica se ejecuta en PowerShell como administrador. No se debe correr en una terminal normal.

## Crear usuarios

```powershell
$password = ConvertTo-SecureString "FitPulse2026!" -AsPlainText -Force
New-LocalUser -Name "alumno1" -Password $password -FullName "Alumno 1"
New-LocalUser -Name "alumno2" -Password $password -FullName "Alumno 2"
New-LocalUser -Name "invitado" -Password $password -FullName "Invitado"
```

## Verificar usuarios

```powershell
Get-LocalUser alumno1, alumno2, invitado | Select-Object Name, Enabled, LastLogon
```

## Deshabilitar un alumno

```powershell
Disable-LocalUser -Name "alumno2"
Get-LocalUser alumno2 | Select-Object Name, Enabled
```

Resultado esperado:

```text
Name     Enabled
----     -------
alumno2  False
```

## Habilitarlo otra vez

```powershell
Enable-LocalUser -Name "alumno2"
Get-LocalUser alumno2 | Select-Object Name, Enabled
```

Resultado esperado:

```text
Name     Enabled
----     -------
alumno2  True
```

## Comandos CLI equivalentes

```powershell
net user alumno1 FitPulse2026! /add
net user alumno2 FitPulse2026! /add
net user invitado FitPulse2026! /add
net user alumno2 /active:no
net user alumno2 /active:yes
net user alumno1
net user alumno2
net user invitado
```

## Evidencia sugerida

- Captura de PowerShell con `Get-LocalUser`.
- Captura de `alumno2` deshabilitado.
- Captura de `alumno2` habilitado otra vez.
