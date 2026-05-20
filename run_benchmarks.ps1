$tests = @(
    @{ Name="1_ValidLogin"; Url="https://practicetestautomation.com/practice-test-login/"; Prompt="username: student, password: Password123. Verify URL contains /logged-in-successfully/, page contains 'Congratulations' or 'successfully logged in', and log out button exists." },
    @{ Name="2_InvalidUsername"; Url="https://practicetestautomation.com/practice-test-login/"; Prompt="username: incorrectUser, password: Password123. Verify Error text exactly says: Your username is invalid!" },
    @{ Name="3_InvalidPassword"; Url="https://practicetestautomation.com/practice-test-login/"; Prompt="username: student, password: incorrectPassword. Verify Error text exactly says: Your password is invalid!" },
    @{ Name="4_Checkboxes"; Url="https://the-internet.herokuapp.com/checkboxes"; Prompt="Toggle checkbox 1 and checkbox 2. Verify their checked/unchecked states changed using DOM state." },
    @{ Name="5_Dropdown"; Url="https://the-internet.herokuapp.com/dropdown"; Prompt="Select Option 1 and verify it is selected. Select Option 2 and verify it is selected." },
    @{ Name="6_JSAlerts"; Url="https://the-internet.herokuapp.com/javascript_alerts"; Prompt="Click JS Alert, accept it, verify result text changed. Click JS Confirm, cancel it, verify result text changed. Click JS Prompt, enter 'QA Agent Test', accept it, verify result contains 'QA Agent Test'." },
    @{ Name="7_DynamicLoading"; Url="https://the-internet.herokuapp.com/dynamic_loading/2"; Prompt="Click Start. Wait until loaded text appears. Verify loaded text is visible." },
    @{ Name="8_StatusCodes"; Url="https://the-internet.herokuapp.com/status_codes"; Prompt="Visit 200, 301, 404, and 500. Confirm each page loads/responds as expected." }
)

foreach ($t in $tests) {
    Write-Host "=============================================="
    Write-Host "Running: $($t.Name)"
    Write-Host "=============================================="
    node out/cli/index.js run --url $t.Url --prompt $t.Prompt
    Write-Host "`n"
}
