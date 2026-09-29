Ecco la guida con tutto quello che resta da provare. In fondo trovi l'elenco di ciò che è già verificato.

## Linux

**1. Device privilegiati senza backend root (AppImage)**
- [ ] Ricostruisci con `make dist-linux` e avvia l'AppImage.
- [ ] Deploya un lab con un device privilegiato e un `[volume]`: una password sbagliata deve dare l'errore nel modal e non avviare nulla; quella giusta deve fare il deploy. `docker inspect` deve mostrare `Privileged: true`, e `ps -o user= -p <pid uvicorn>` il tuo utente, non root.
- [ ] Deploy del solo device privilegiato (dal menu del device): deve chiedere la password e partire.
- [ ] Con una regola `NOPASSWD` in sudoers il modal non deve avere il campo password, e "Continue" deve fare il deploy.
- [ ] `curl -X POST` su `/api/labs/<id>/deploy` con il solo token di pairing deve rispondere 403 `DeployNotAuthorizedError`.

**2. Dialoghi nativi**
- [ ] "Undeploy all and quit": chiudi l'app con un lab deployato. Dopo, `docker ps` non deve mostrare container di quel lab.
- [ ] "Undeploy all and continue": cambia la cartella dei lab dai Settings con un lab deployato. I container devono sparire e l'app deve ripartire sulla nuova cartella.
- [ ] (facoltativo) Primo avvio con `XDG_CONFIG_HOME=/tmp/kathara-firstrun2`: premi "Choose a different folder…" e **annulla**. L'app deve restare sul prompt; poi "Continue" deve funzionare.

**3. Copia e incolla**
- [ ] Il pulsante di copia nel pannello notifiche, dopo aver provocato un errore.
- [ ] Nel terminale: `Ctrl+Shift+C` e `Ctrl+Shift+V`, anche con testo copiato da fuori.
- [ ] Nell'editor: `Ctrl+C`, `Ctrl+X`, `Ctrl+V` e il menu del tasto destro.
- [ ] Alla fine, `grep "refused web permission" ~/.config/kathara-desktop/logs/backend.log` non deve mostrare altro oltre alle mie tre righe di prova delle 16:10.

**4. Messaggi d'errore**
- [ ] Il comando `exec` `echo "ciao"` nel form del device deve dare un toast leggibile sulle virgolette.
- [ ] `pc1[0]=A/zz` nell'editor del `lab.conf` deve dare l'errore "invalid MAC address".
- [ ] `ln -s ~/.ssh <device>/root/chiavi` in un lab deve far rifiutare il deploy con "leads outside the lab". Poi `rm` del link e il deploy deve funzionare.
- [ ] Aprire `/dev/zero` da un device avviato deve dare l'errore dei 64 MB.
- [ ] Incollare una cartella dentro sé stessa deve dare "Can't paste … into itself."
- [ ] In Settings → System deve comparire "Docker version: …".
- [ ] Importare uno `.zip` con `pc1[privileged]=true` non deve avviare nulla; al deploy deve comparire la richiesta della password.

**5. Stack Compose**
- [ ] `docker compose -f docker-compose-dev.yml up --build`, poi apri `http://localhost:5173`. Il terminale di un device deve funzionare, senza errori 400 sull'Host.

## macOS

- [ ] `make dist-mac`, installa il `.dmg` e al primo avvio `xattr -dr com.apple.quarantine "/Applications/Kathara-Desktop.app"`.
- [ ] Deploya un lab privilegiato: deve comparire il dialogo di amministratore di macOS, e dopo la password il device deve partire con il backend che resta del tuo utente.
- [ ] Limite di tentativi: annulla il dialogo di amministratore 6 volte. Dopo il quinto annullamento l'app deve dire che i tentativi sono troppi; dopo circa 30 secondi deve riproporlo.
- [ ] "Undeploy all and quit", primo avvio con "Choose a different folder…" e copia-incolla, come su Linux.

## Windows

- [ ] Ricostruisci l'installer sul PC Windows (`make dist-win`) e installalo.
- [ ] Deploya un lab privilegiato: deve comparire UAC, e dopo averlo accettato il device deve partire senza riavviare il backend.
- [ ] Limite di tentativi: annulla UAC 6 volte, con lo stesso comportamento atteso del Mac.
- [ ] "Undeploy all and quit" e copia-incolla, come su Linux.

## Release

- [ ] Alla prossima release controlla che il job di pubblicazione passi con `softprops/action-gh-release` fissato alla commit.

## Pulizia

- [ ] Togli i container rimasti da prove vecchie, se ce ne sono (`docker ps | grep kathara_`).
- [ ] Cancella `/tmp/kathara-firstrun*` e `/home/tommaso/test`, che è vuota.

**Già verificato**
- Riavvio automatico in-place, finestra terminale staccata compresa.
- Primo avvio con la scelta di una cartella diversa.
- Negazione dei permessi web: notifiche, microfono, geolocalizzazione.
- Upload, `/dev/zero` e deploy, via API.

Se ti serve da spuntare sul Mac, posso metterla in una pagina condivisa.