# State v. Tom Robinson — Live Jury Vote

Students join on their phones as jurors and vote **Guilty / Not Guilty** twice. The host controls when each vote opens.

## Run it

You need Node.js 18 or newer.

```bash
npm install && npm start
```

The console prints the host URL (`http://localhost:3000/host`) and the Wi-Fi URL for phones.

1. Open **/host** on the projector computer and click **Create Room**.
2. Click **Show QR code** when you want students to join (click again to hide it). Scanning joins them straight away. Each student gets a random juror number, so all votes are anonymous. If the QR doesn't work, they can open the URL and type the room code **1234**. There is only one room and its code is always 1234. Opening /host on another screen and clicking Create Room joins that same room. To start over, use **Reset session**.
3. The host clicks through: **Open Vote 1 → Close Vote 1 → Show Vote 1 Results → Open Vote 2 → Close Vote 2 → Show Vote 2 Results → Show Final Verdict**. Results stay hidden until you click Show Results. To move on without showing a vote's results, click **Skip results** instead.

**Reset session** clears all votes and returns to the room screen.

Phones must be on the same Wi-Fi as the host computer.

### Phones can't open the page after scanning

Windows Firewall is blocking Node.js. In **PowerShell run as Administrator**:

```powershell
Set-NetConnectionProfile -InterfaceAlias "Wi-Fi" -NetworkCategory Private
New-NetFirewallRule -DisplayName "Jury app (port 3000)" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
```

## Put it online (Render, free)

Online, phones can join from any network, including mobile data, and no firewall setup is needed.

1. Create a free account at **github.com**. Make a new repository, and upload everything in this folder **except** `node_modules` (use "Add file → Upload files").
2. Create a free account at **render.com** and choose **New → Blueprint**. Pick your repository and click **Apply**. Render reads `render.yaml` and sets everything up.
3. When it says **Live**, open `https://<your-app>.onrender.com/host`. The QR code automatically points to that online address.

Notes:
- The free plan sleeps after 15 minutes without visitors. Open the host page about a minute before class to wake it up.
- Votes are kept in memory. If Render restarts the app, the session starts fresh.
- Anyone who knows the address can open `/host`, so share only the QR code with students.
- To change the questions online, edit `questions.json` on GitHub. Render redeploys automatically.

## Editing the questions

Edit **`questions.json`**. Each of the two `votes` has a `title` and a `prompt`. Changes show up the next time a screen loads; no restart needed.
