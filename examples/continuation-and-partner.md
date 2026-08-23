# Provider limit and partner handoff

If the host reaches a provider limit, preserve the active Sigmora project and ask the user to choose among retrying the provider, an explicitly priced Sigmora continuation, opening the dashboard, or cancelling. Never switch automatically.

For presenter generation, first detect whether the official HeyGen capability is connected. A connected call uses the user's HeyGen credits and must be labelled `partner_billed_external`. If it is not connected, ask before authorization. A native Sigmora alternative must be labelled `sigmora_metered` and must not be described as HeyGen output.
