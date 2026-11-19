# LabBridge — Ghid Rapid pentru Echipă (VS Code + Copilot + Linux Lab)

**LabBridge** este un workbench SSH2 + SFTP nativ pentru Windows, fără instalare cu drepturi de Administrator (**Zero-Admin**), gândit pentru dezvoltare locală în **VS Code + GitHub Copilot** cu execuție și compilare pe serverele și plăcile Linux din laborator.

---

## 1. Pornire Rapidă (Mod Portabil Zero-Admin)

1. Dezarhivează `LabBridge-Portable.zip` într-un folder local (ex. `C:\Tools\LabBridge\`).
2. Păstrează fișierul gol **`portable.mode`** lângă **`LabBridge.exe`**:
   - Toate profilurile (`profiles.json`), amprentele SSH (`known_hosts`), starea ferestrei (`ui_state.json`) și logurile sunt salvate local în `./data/`.
   - Parolele și passphrase-urile cheilor SSH **nu** sunt scrise niciodată pe disc — sunt stocate exclusiv în **Windows Credential Manager** pe contul tău de utilizator.
3. Rulează direct **`LabBridge.exe`** (nu necesită drepturi de Admin; folosește WebView2 preinstalat în Windows 10/11).

---

## 2. Configurarea Primului Profil de Laborator

1. Apasă **`+`** în bara de sus (sau `Ctrl+,`) pentru a deschide **LabBridge Configuration**.
2. Completează:
   - **Target Host / Port / Username**: adresa mașinii Linux din laborator.
   - **Autentificare**:
     - *Private Key File* (`~/.ssh/id_ed25519` etc., cu passphrase opțional în Keyring),
     - *Password (Keyring)*, sau
     - *Windows SSH Agent* (conectare directă la `\\.\pipe\openssh-ssh-agent`).
   - **ProxyJump (Bastion)** *(opțional)*: bifează dacă mașina din lab este accesibilă doar printr-un server intermediar (jump host).
   - **Local Windows Root Path**: folderul proiectului de pe laptop (ex. `C:\work\firmware`).
   - **Remote Linux POSIX Root Path**: folderul corespondent de pe serverul Linux (ex. `/home/user/firmware`).
3. Salvează profilul și apasă **Connect** (la prima conectare, verifică și acceptă amprenta SHA-256 a serverului).

---

## 3. Fluxul Zilnic: VS Code + GitHub Copilot + LabBridge

1. **Editează local cu latență zero**:
   - Apasă butonul **Open Workspace in VS Code** din panoul stâng.
   - Spre deosebire de VS Code Remote-SSH (care poate consuma RAM/CPU pe placa de lab sau se blochează când pică VPN-ul), VS Code și **GitHub Copilot Agent Mode** rulează 100% local pe laptopul tău.
2. **Sincronizare automată inteligentă (`Local -> Remote`)**:
   - **Salvare rapidă (1–3 fișiere < 2 MB)**: urcare atomică prin SFTP (`.labbridge.tmp.<nume>` -> `rename`), astfel încât compilatorul de pe Linux nu citește niciodată fișiere scrise pe jumătate.
   - **Editări masive AI / Git (4+ fișiere)**: compresie și streaming `.tar.gz` direct într-un canal SSH `exec`.
   - **Protecție Git Lock**: în timpul unui `git switch`, `checkout` sau `rebase`, LabBridge detectează `.git/index.lock` / `.git/HEAD.lock`, pune sincronizarea în așteptare (*Waiting on Git lock...*) și trimite un singur pachet curat după finalizarea operației Git.
   - **CRLF Guard & Permisiuni Linux**: convertește automat în memorie `CRLF -> LF` pentru scripturi (`.sh`, `.py`, `Makefile`, `Kconfig`) fără să modifice fișierele locale de pe Windows și păstrează biții de execuție (`0755`).
   - Artefactele de compilare de pe Linux (`build/`, `out/`, `target/`) **nu** sunt descărcate automat înapoi pe laptop.
3. **Compilare, Testare și Flash dintr-o tastă (`Alt+1` .. `Alt+5`)**:
   - Folosește **Macro Bar**-ul de deasupra terminalului (`Build`, `Run CTest`, `Flash Target`, `Serial / dmesg`, `Clean`).
   - Opțiunea *Flush pending sync before running* garantează că toate fișierele salvate în VS Code au ajuns pe Linux înainte să pornească `make` sau scriptul de flash.
4. **Explorare SFTP & Descărcare Loguri / Binare**:
   - Trage prin *Drag & Drop* (sau apasă **Download**) orice fișier sau folder de loguri/core-dump din panoul **Remote Linux SFTP** către laptop.
   - Activează **Follow Terminal: ON** (și apasă **Inject Prompt Hook** dacă shell-ul remote nu emite nativ OSC 7) pentru ca panoul SFTP să urmărească automat `cd`-urile din terminal.
   - Click dreapta pe orice fișier -> **Compare Local vs Remote** pentru verificare SHA-256 și diff side-by-side.

---

## 4. Reziliență VPN & Scurtături Tastatură

Dacă VPN-ul are o întrerupere scurtă sau placa din lab repornește, LabBridge trece automat în **Reconnecting** (1s, 2s, 5s, 10s), reface conexiunea SSH + SFTP, sincronizează automat modificările făcute offline și îți permite să redeschizi shell-ul pe loc apăsând **`Enter`** în tab-ul existent (păstrând istoricul din terminal).

| Scurtătură | Acțiune |
| :--- | :--- |
| `Alt+1` .. `Alt+5` | Execută macro-urile de build / test / flash ale profilului activ |
| `Ctrl+Shift+T` | Deschide un tab nou de terminal SSH multiplexat |
| `Ctrl+Shift+W` | Închide tab-ul de terminal activ |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copy / Paste în terminal (fără a trimite `SIGINT`) |
| `Ctrl+Shift+F` | Căutare în bufferul terminalului activ |
| `Ctrl+J` | Maximizează / restaurează dock-ul de terminal |
| `Ctrl+,` | Deschide configurarea profilurilor și `known_hosts` |
