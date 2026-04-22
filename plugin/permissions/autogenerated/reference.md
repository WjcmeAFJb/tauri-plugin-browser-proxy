## Default Permission

Grant the bridge webview access to the plugin's relay commands. Required for
the browser-proxy to function. These commands are strictly local-loopback
control plane — they never read or write user data directly.

#### This default permission set includes the following:

- `allow-register-bridge`
- `allow-relay-result`
- `allow-relay-event`
- `allow-proxy-url`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`browser-proxy:allow-proxy-url`

</td>
<td>

Enables the proxy_url command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`browser-proxy:deny-proxy-url`

</td>
<td>

Denies the proxy_url command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`browser-proxy:allow-register-bridge`

</td>
<td>

Enables the register_bridge command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`browser-proxy:deny-register-bridge`

</td>
<td>

Denies the register_bridge command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`browser-proxy:allow-relay-event`

</td>
<td>

Enables the relay_event command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`browser-proxy:deny-relay-event`

</td>
<td>

Denies the relay_event command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`browser-proxy:allow-relay-result`

</td>
<td>

Enables the relay_result command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`browser-proxy:deny-relay-result`

</td>
<td>

Denies the relay_result command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`browser-proxy:allow-proxy-url`

</td>
<td>

Allows reading the proxy's public URL — used by the shim for status display.

</td>
</tr>

<tr>
<td>

`browser-proxy:allow-register-bridge`

</td>
<td>

Allows calling register_bridge from the bridge webview.

</td>
</tr>

<tr>
<td>

`browser-proxy:allow-relay-event`

</td>
<td>

Allows the bridge webview to forward intercepted Tauri events to browser tabs.

</td>
</tr>

<tr>
<td>

`browser-proxy:allow-relay-result`

</td>
<td>

Allows the bridge webview to relay an invoke result back to the HTTP server.

</td>
</tr>
</table>
