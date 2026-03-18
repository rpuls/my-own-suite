import type { RadicaleDevice } from './DeviceSelector';

type DeviceGuideProps = {
  device: RadicaleDevice;
};

export function DeviceGuide({ device }: DeviceGuideProps) {
  if (device === 'ios') {
    return (
      <div className="suite-guide-card">
        <h4>On your iPhone or iPad</h4>
        <p className="suite-guide-warning">
          Do not open the server address in Safari or Chrome. Add it inside the iPhone Calendar account screen.
        </p>
        <ol className="suite-guide-list">
          <li>Open <strong>Settings</strong>.</li>
          <li>Open <strong>Apps</strong>, then <strong>Calendar</strong>, then <strong>Calendar Accounts</strong>, then <strong>Add Account</strong>.</li>
          <li>Tap <strong>Add Other Account</strong>, then <strong>Add CalDAV Account</strong>.</li>
          <li>Paste the <strong>Server URL</strong> below into the <strong>Server</strong> field.</li>
          <li>Paste the <strong>Username</strong> below into the <strong>User Name</strong> field.</li>
          <li>Open Vaultwarden, find the <strong>Radicale</strong> item, and paste its password.</li>
          <li>Tap <strong>Next</strong> or <strong>Save</strong>, then open the Calendar app to confirm the account appears there.</li>
        </ol>
        <p className="suite-guide-note">
          If these menu names look a little different on your iPhone or iPad, ask Siri: <strong>How do I add a CalDAV calendar on this device?</strong>
        </p>
      </div>
    );
  }

  if (device === 'android') {
    return (
      <div className="suite-guide-card">
        <h4>On your Android phone or tablet</h4>
        <p className="suite-guide-warning">
          On Android, the easiest setup is to use DAVx5 to connect your private calendar, then view it in your normal calendar app.
        </p>
        <ol className="suite-guide-list">
          <li>Install and open <strong>DAVx5</strong>. This is the app that connects Android to your private calendar server.</li>
          <li>Add a new CalDAV account and choose the option that lets you enter a server address and user name.</li>
          <li>Paste the <strong>Server URL</strong> below into the server or base URL field.</li>
          <li>Paste the <strong>Username</strong> below into the user name field.</li>
          <li>Open Vaultwarden, find the <strong>Radicale</strong> item, and paste its password.</li>
          <li>If your phone is not nearby, <strong>Show QR</strong> only helps move the server address onto it. It does not add the calendar automatically.</li>
          <li>Finish the DAVx5 setup and make sure your calendar is enabled after DAVx5 finds it.</li>
          <li>After that, open your normal calendar app, or install <strong>Etar</strong> if you want a simple open-source calendar app.</li>
        </ol>
      </div>
    );
  }

  if (device === 'mac') {
    return (
      <div className="suite-guide-card">
        <h4>On your Mac</h4>
        <p className="suite-guide-warning">
          Use Apple Calendar. Do not paste the server address into Safari or another browser.
        </p>
        <ol className="suite-guide-list">
          <li>Open <strong>Calendar</strong>.</li>
          <li>Choose <strong>Calendar</strong>, then <strong>Add Account</strong>.</li>
          <li>Choose <strong>Add Other Account</strong>, then <strong>CalDAV Account</strong>.</li>
          <li>When asked how to sign in, choose the option that lets you enter the account details manually.</li>
          <li>Paste the <strong>Server URL</strong> below into the server field.</li>
          <li>Paste the <strong>Username</strong> below into the user name field.</li>
          <li>Open Vaultwarden, find the <strong>Radicale</strong> item, and paste its password.</li>
          <li>Finish setup and confirm the calendar appears in Apple Calendar.</li>
        </ol>
      </div>
    );
  }

  return (
    <div className="suite-guide-card">
      <h4>On your Windows computer</h4>
      <p className="suite-guide-warning">
        Use Thunderbird. Do not paste the server address into your browser.
      </p>
      <ol className="suite-guide-list">
        <li>We recommend using <strong>Thunderbird</strong> for the easiest CalDAV setup.</li>
        <li>Open Thunderbird Calendar and create a <strong>New Calendar</strong>.</li>
        <li>Choose <strong>On the Network</strong>, then <strong>CalDAV</strong> if Thunderbird asks.</li>
        <li>Paste the <strong>Server URL</strong> below into the location or server field.</li>
        <li>Paste the <strong>Username</strong> below when Thunderbird asks for it.</li>
        <li>When prompted for a password, open Vaultwarden, find the <strong>Radicale</strong> item, and paste its password.</li>
        <li>Choose your calendar when Thunderbird lists it, then finish setup.</li>
      </ol>
    </div>
  );
}
