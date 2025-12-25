from playwright.sync_api import sync_playwright, expect
import time
import os

def verify_lottery(page_controller, page_display):
    # Navigate
    page_controller.goto("http://localhost:8080/controller.html")
    page_display.goto("http://localhost:8080/index.html")

    # Wait for loads
    page_controller.wait_for_load_state("networkidle")
    page_display.wait_for_load_state("networkidle")

    print("Pages loaded")

    # --- Test 1: Loop Mode Cycle (A, B) ---
    # Setup Deck
    deck_input = page_controller.locator("#deckInput")
    deck_input.fill("A\nB")

    # Select Loop
    page_controller.locator("input[value='loop']").check()

    # Save & Reset
    page_controller.get_by_text("設定保存 & リセット").click()

    print("Deck set to A, B (Loop)")

    # Spin 1
    page_controller.get_by_role("button", name="1P SPIN").click()
    print("Spin 1 clicked")
    time.sleep(1)

    # Spin 2
    page_controller.get_by_role("button", name="1P SPIN").click()
    print("Spin 2 clicked")
    time.sleep(1)

    count_text = page_controller.locator("#deckCount").text_content()
    print(f"Deck count after 2 spins: {count_text}")

    # Spin 3 (Trigger Reset)
    page_controller.get_by_role("button", name="1P SPIN").click()
    print("Spin 3 clicked (Reset Cycle)")
    time.sleep(1)

    count_text = page_controller.locator("#deckCount").text_content()
    print(f"Deck count after 3 spins: {count_text}")

    # Take screenshot of display
    page_display.screenshot(path="verification/display_loop_cycle.png")


    # --- Test 2: Exhaust Mode ---
    # Switch to Exhaust
    page_controller.locator("input[value='exhaust']").check()

    # Spin 4 (Pick remaining B)
    page_controller.get_by_role("button", name="1P SPIN").click()
    print("Spin 4 clicked (Exhaust)")
    time.sleep(1)

    # Spin 5 (Should be Miss)
    page_controller.get_by_role("button", name="1P SPIN").click()
    print("Spin 5 clicked (Miss expected)")
    time.sleep(1)

    # Check status
    status_text = page_controller.locator("#deckStatus").text_content()
    print(f"Status: {status_text}")

    page_display.screenshot(path="verification/display_exhaust_miss.png")

if __name__ == "__main__":
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()

        page_ctrl = context.new_page()
        page_disp = context.new_page()

        try:
            verify_lottery(page_ctrl, page_disp)
        except Exception as e:
            print(f"Error: {e}")
        finally:
            browser.close()
